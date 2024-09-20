//	gr: erk external dependencies!
import {SplitArrayIntoChunks,JoinTypedArrays} from '../PopApi.js'
import {MatrixMultiply4x4,CreateTranslationMatrix,CreateTranslationQuaternionMatrix,CreateIdentityMatrix,MatrixInverse4x4,TransformPosition} from '../Math.js'



function Lerp(PrevValue,NextValue,LerpTime)
{
	//	need to do each element if array (position, colour etc)
	if ( Array.isArray(PrevValue) || ArrayBuffer.isView(PrevValue) )
	{
		function LerpElement(PrevElement,Index)
		{
			const NextElement = NextValue[Index];
			return Lerp( PrevElement, NextElement, LerpTime );
		}
		const Out = PrevValue.map(LerpElement);
		return Out;
	}
	
	if ( typeof PrevValue != typeof 123.456 )
		throw `todo: lerp non-number; ${typeof PrevValue}`;
	
	const OutValue = PrevValue + ( (NextValue-PrevValue) * LerpTime );
	return OutValue;
}


function Slerp(PrevValue,NextValue,LerpTime)
{
	if ( PrevValue.length != 4 )
		throw `Slerp expecting 4 elment array`;

	let out = [];
	let a = PrevValue;
	let b = NextValue;
	let t = LerpTime;
	
	//	https://github.com/toji/gl-matrix/blob/master/src/quat.js#L296
	let ax = a[0],
		ay = a[1],
		az = a[2],
		aw = a[3];
	let bx = b[0],
	  by = b[1],
	  bz = b[2],
	  bw = b[3];

	let omega, cosom, sinom, scale0, scale1;

	// calc cosine
	cosom = ax * bx + ay * by + az * bz + aw * bw;
	// adjust signs (if necessary)
	if (cosom < 0.0) {
	  cosom = -cosom;
	  bx = -bx;
	  by = -by;
	  bz = -bz;
	  bw = -bw;
	}
	const EPSILON = 0.00001;
	// calculate coefficients
	if (1.0 - cosom > EPSILON) {
	  // standard case (slerp)
	  omega = Math.acos(cosom);
	  sinom = Math.sin(omega);
	  scale0 = Math.sin((1.0 - t) * omega) / sinom;
	  scale1 = Math.sin(t * omega) / sinom;
	} else {
	  // "from" and "to" quaternions are very close
	  //  ... so we can do a linear interpolation
	  scale0 = 1.0 - t;
	  scale1 = t;
	}
	// calculate final values
	out[0] = scale0 * ax + scale1 * bx;
	out[1] = scale0 * ay + scale1 * by;
	out[2] = scale0 * az + scale1 * bz;
	out[3] = scale0 * aw + scale1 * bw;

	return out;

}

function Range(Min,Max,Value)
{
	return (Value-Min)/(Max-Min);
}



//	gr: currently a virtual frame but later this may be flat data
export class AnimationFrame
{
	constructor(TimeSecs,ParentClip)
	{
		this.TimeSecs = TimeSecs;
		this.ParentClip = ParentClip;
	}
	
	GetValue(ObjectName,Property)
	{
		//	find track in clip
		const Track = this.ParentClip.GetTrack( ObjectName, Property );
		if ( !Track )
		{
			return null;
		}
		
		//	find prev&next keyframes
		const InterpolatedValue = Track.GetValue(this.TimeSecs);
		return InterpolatedValue;
	}
}

const InterpolationMethod =
{
	Linear:			'LINEAR',
	Slerp:			'SphericalLerp',	//	not in GLTF, but we catch it as rotations must be slerp'd
	Step:			'STEP',
	BezierCubic:	'CUBICSPLINE'	//	value & 2 tangents (+next value)
};

export class AnimationTrack
{
	get KeyframeTimes()		{	return this.TimeData.Array;	}
	get FirstKeyframeTime()	{	return this.KeyframeTimes[0];	}
	get LastKeyframeTime()	{	return this.KeyframeTimes[this.KeyframeTimes.length-1];	}

	
	GetValue(TimeSecs)
	{
		const KeyframeTimes = this.KeyframeTimes;

		//	workout prev & next indexes to lerp between
		let PrevIndex = 0;
		for ( let k=0;	k<KeyframeTimes.length;	k++ )
		{
			const KeyframeTime = KeyframeTimes[k];
			if ( KeyframeTime > TimeSecs )
			{
				break;
			}
			PrevIndex = k;
		}
		const NextIndex = Math.min(PrevIndex + 1, KeyframeTimes.length-1);
		const PrevValue = this.#GetKeyframeValue(PrevIndex);
		const NextValue = this.#GetKeyframeValue(NextIndex);
		const PrevTime = KeyframeTimes[PrevIndex];
		const NextTime = KeyframeTimes[NextIndex];
		const LerpTime = Range( PrevTime, NextTime, TimeSecs );

		if ( PrevIndex == NextIndex )
			return PrevValue;

		const Value = this.#Interpolate( PrevValue, NextValue, LerpTime );
		return Value;
	}
	
	#Interpolate(PrevValue,NextValue,LerpTime)
	{
		if ( LerpTime <= 0.0 )
			return PrevValue;
		if ( LerpTime >= 1.0 )
			return NextValue;
		
		switch ( this.InterpolationMethod )
		{
			case InterpolationMethod.Linear:	return Lerp(PrevValue,NextValue,LerpTime);
			case InterpolationMethod.Slerp:		return Slerp(PrevValue,NextValue,LerpTime);
			default:	throw `Unhandled interpolation method ${this.InterpolationMethod}`;
		}
	}
	
	#GetKeyframeValue(KeyframeIndex)
	{
		const ElementCount = this.ValueData.Meta.ElementSize;
		const FirstIndex = KeyframeIndex * ElementCount;
		return this.ValueData.Array.slice( FirstIndex, FirstIndex+ElementCount );
	}

	get InterpolationMethod()	
	{
		if ( this.Property == 'rotation' )
		{
			return InterpolationMethod.Slerp;
		}
		return this.SamplerMeta.interpolation;
	}
}

//	generic animation class
export class AnimationClip
{
	static GetTrackKey(ObjectName,Property)
	{
		if ( ObjectName.startsWith('mixamorig:') )
			ObjectName = ObjectName.slice('mixamorig:'.length);

		return `${ObjectName}/${Property}`;
	}
	
	#Tracks = {};	//	AnimationTrack
	
	constructor(GltfAnimation,GetNodeMeta,GetArrayAndMeta)
	{
		//	channel = track/spline/curve
		//	channel node = node = joint
		console.log(`Animation clip`,GltfAnimation);
		
		function GetSamplerMeta(SamplerIndex)
		{
			return GltfAnimation.samplers[SamplerIndex];
		}
		
		//	for our purposes, save each channel/track
		function ChannelToTrack(Channel)
		{
			//	sampler meta defines input accessor(time) and output accessor(data)
			//	and how to interpolate it
			const SamplerMeta = GetSamplerMeta(Channel.sampler);
			let NodeIndex = Channel.target.node;
			let PropertyName = Channel.target.path;
			
			//	path may be an extension
			//	https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_animation_pointer/README.md
			if ( Channel.target.extensions?.KHR_animation_pointer )
			{
				const Pointer = Channel.target.extensions.KHR_animation_pointer;
				if ( Channel.target.path != 'pointer' )
					throw `KHR_animation_pointer extension in target path(${Channel.target.path}) expected to be "pointer"`;
				//	/materials/0/pbrMetallicRoughness/baseColorFactor
				//	/nodes/6/translation
				const PathParts = Pointer.pointer.split('/');
				const PreSlash = PathParts.shift();
				const TargetType = PathParts.shift();
				const TargetIndex = Number(PathParts.shift());
				PropertyName = PathParts.join('.');
				if ( TargetType == 'nodes' )
					NodeIndex = TargetIndex;
			}

			//	todo: handle when not a node from KHR_Animation extension
			const Node = GetNodeMeta(NodeIndex);

			const Track = new AnimationTrack();
			Track.Property = PropertyName;
			Track.ObjectName = Node?.name;
			Track.SamplerMeta = SamplerMeta;
			Track.TimeData = GetArrayAndMeta( Track.SamplerMeta.input );
			Track.ValueData = GetArrayAndMeta( Track.SamplerMeta.output );
			return Track;
		}
		const Tracks = GltfAnimation.channels.map(ChannelToTrack);
		Tracks.forEach( this.#AddTrack.bind(this) );
	}
	
	get LastKeyframeTime()
	{
		const Tracks = Object.values( this.#Tracks );
		if ( Tracks.length == 0 )
			return NaN;
		
		let LargestKeyframeTime = Tracks[0].LastKeyframeTime;
		Tracks.forEach( t => LargestKeyframeTime = Math.max( LargestKeyframeTime, t.LastKeyframeTime ) );
		return LargestKeyframeTime;
	}
	
	//	extract an animation frame[interface] for this time
	GetFrame(TimeSecs)
	{
		return new AnimationFrame(TimeSecs,this);
	}
	
	#AddTrack(Track)
	{
		const Key = AnimationClip.GetTrackKey( Track.ObjectName, Track.Property );

		if ( this.#Tracks.hasOwnProperty(Key) )
			throw `Duplicate track; ${Key}`;
		
		this.#Tracks[Key] = Track;
	}
	
	GetTrack(ObjectName,Property)
	{
		const Key = AnimationClip.GetTrackKey( ObjectName, Property );
		return this.#Tracks[Key];
	}

}



//	generic skeleton class

export class SkeletonJoint
{
	constructor(Name)
	{
		this.Name = Name;
		this.WorldPosition = [0,0,0];	//	only use for quick debug!
		this.LocalPosition = [0,0,0];
		this.LocalRotation = [0,0,0,1];
		this.Parents = [];	//
	}

	get ParentCount()	{	return this.Parents.length;	}
	
	get LocalTransform()	{	return CreateTranslationQuaternionMatrix( this.LocalPosition, this.LocalRotation );	}
}

export class Skeleton_t
{
	#Joints = [];	//	[SkeletonJoint] in skinning order
	#TreeDepthOrder = [];	//	index to #Joints in depth order (so fewer parents first)
	
	constructor(Name,JointNodeIndexes,GetNodeMeta)
	{
		//	a root node is implied at "the origin"
		//	https://github.com/KhronosGroup/glTF-Tutorials/blob/main/gltfTutorial/gltfTutorial_020_Skins.md
		//	origin of... the scene? the skinned node? 0,0,0?
		//const RootJoint = new SkeletonJoint('Root');
		//this.#Joints.push( RootJoint );
		
		//	root == JointNodeIndexes[0]
		//	v1 just get a list of joints
		function GetSkeletonJoint(NodeIndex)
		{
			const NodeMeta = GetNodeMeta(NodeIndex);
			const Joint = new SkeletonJoint(NodeMeta.name);
			
			const LocalTranslation = NodeMeta.translation.slice();
			const LocalRotation = (NodeMeta.rotation??[0,0,0,1]).slice();
			Joint.JointToWorldTransform = NodeMeta.JointToWorldTransform;
			Joint.LocalPosition = LocalTranslation;
			Joint.LocalRotation = LocalRotation;

			const WorldTranslation = TransformPosition( [0,0,0], Joint.JointToWorldTransform );
			Joint.WorldPosition = WorldTranslation;

			Joint.JointIndex = NodeMeta.JointIndex;
			
			function GetParentJointIndex()
			{
				for ( let ThatNodeIndex of JointNodeIndexes )
				{
					const ThatNodeMeta = GetNodeMeta(ThatNodeIndex);
					if ( ThatNodeMeta.children.includes(NodeIndex) )
						return ThatNodeMeta.JointIndex;
				}
				return null;
			}
			function GetChildJointIndex(ChildNodeIndex)
			{
				const ChildNodeMeta = GetNodeMeta(ChildNodeIndex);
				return ChildNodeMeta.JointIndex;
			}
			Joint.Children = NodeMeta.children.map(GetChildJointIndex);
			Joint.Parent = GetParentJointIndex();
			return Joint;
		}
		this.#Joints.push( ...JointNodeIndexes.map( GetSkeletonJoint ) );
		
		function SetParents(Joint)
		{
			Joint.Parents = [];
			let p = Joint.Parent;
			for ( let i=0;	i<1000;	i++ )
			{
				if ( p === null )
					break;
				Joint.Parents.push(p);
				const Parent = this.#Joints[p];
				p = Parent.Parent;
			}
		}
		
		this.#Joints.forEach( SetParents.bind(this) );
		
		function CompareParentCount(JointIndexA,JointIndexB)
		{
			const JointA = this.#Joints[JointIndexA];
			const JointB = this.#Joints[JointIndexB];
			if ( JointA.ParentCount < JointB.ParentCount )	
				return -1;
			if ( JointA.ParentCount > JointB.ParentCount )	
				return 1;
			return 0;
		}
		
		this.#TreeDepthOrder = Object.keys(this.#Joints).map(Number).sort( CompareParentCount.bind(this) );
	}
	
	//	enum all joints
	get Joints()
	{
		//const Joints = [];
		//this.JointTree.EnumJoints( j => Joints.push(j) );
		//return Joints;
		return this.#Joints;
	}
	
	//	get transform in joint space
	//	gr: should this returned key'd data?
	#GetJointTransforms(AnimationFrame)
	{
		function GetJointTranform(Joint)
		{
			//	these REPLACE existing values, but only if present
			//	so we use the original ones as backup
			let Translation = AnimationFrame?.GetValue(Joint.Name,'translation');
			let Rotation = AnimationFrame?.GetValue(Joint.Name,'rotation');
			
			//	test moving just the root
			if ( Joint.Name != 'mixamorig:Hips' )
			{
				//Translation = null;
				//Rotation = null;
			}
			
			//	inherit if not animated
			Translation = Translation || Joint.LocalPosition;
			Rotation = Rotation || Joint.LocalRotation;

			const Transform = CreateTranslationQuaternionMatrix( Translation, Rotation );
			return Transform;
		}
		
		const JointFrameTransforms = this.#Joints.map( GetJointTranform );

		return JointFrameTransforms;
	}
	
	//	get all the joint transforms, but transformed in heirachy
	//	gr: this isnt what we want to apply to joint matrix though?
	//	https://github.com/KhronosGroup/glTF-Sample-Viewer/blob/d32ca25dc273c0b0982e29efcea01b45d0c85105/src/skin.js#L32-L36
	GetJointWorldTransforms(AnimationFrame)
	{
		const JointTransforms = this.#GetJointTransforms(AnimationFrame);//.map( x => CreateIdentityMatrix() );
		
		//	now turn into tree-waterfalled transforms
		
		let WorldTransforms = JointTransforms.map( x => CreateIdentityMatrix() );
		let AppliedParentTransforms = {};
		
		function GetJointWorldTransform(JointIndex)
		{
			const Joint = this.#Joints[JointIndex];
			
			//	this worldtransform is from joint->world (inverse bind) so *0,0,0 should be in the same place as a heirachy transform
			//return Joint.WorldTransform;
			
			//	local joint transform(animation) in joint space
			//		-> joint transform from parent
			//			-> parent's world transform
			let JointWorldTransform = Joint.LocalTransform;
			JointWorldTransform = JointTransforms[JointIndex];
			
			//let ParentIndex = Joint.Parent;
			//if ( ParentIndex !== null )
			for ( let ParentIndex of Joint.Parents )
			{
				if ( !AppliedParentTransforms[ParentIndex] )
					throw `Using transform that isn't yet applied in tree`;
				
				//	due to depth order, this one should have already been calculated
				//const ParentTransform = WorldTransforms[ParentIndex];
				
				const ParentJoint = this.#Joints[ParentIndex];
				let ParentTransform = ParentJoint.LocalTransform;
				ParentTransform = JointTransforms[ParentIndex];

				JointWorldTransform = MatrixMultiply4x4( ParentTransform, JointWorldTransform );
			}
			
			return JointWorldTransform;
		}
		
		for ( let i=0;	i<this.#TreeDepthOrder.length;	i++ )
		{
			const JointIndex = this.#TreeDepthOrder[i];
			const WorldTransform = GetJointWorldTransform.call(this,JointIndex);
			AppliedParentTransforms[JointIndex] = true;
			WorldTransforms[JointIndex] = WorldTransform;
		}
		
		/*
		
		//	now for each joint we need to accumulate the transforms from its parents
		//		we have the tree order, (first is root, then first branch, etc) so we can
		//		just calculate them one by one and look up the already-transformed parent
		//	todo; Here is where we could mix multiple anims
		let AppliedParentTransforms = {};
		let WorldTransforms = JointTransforms.slice();
		
		for ( let i=0;	i<this.#TreeDepthOrder.length;	i++ )
		{
			const j = this.#TreeDepthOrder[i];
			const Joint = this.#Joints[j];
			
			let Transform = WorldTransforms[j];
			//for ( let ParentIndex of Joint.Parents )
			let ParentIndex = Joint.Parent;
			if ( ParentIndex !== null )
			{
				if ( !AppliedParentTransforms[ParentIndex] )
					throw `Using transform that isn't yet applied in tree`;
				//	due to depth order, this one should have already been calculated
				const ParentTransform = WorldTransforms[ParentIndex];
				Transform = MatrixMultiply4x4( ParentTransform, Transform );
			}
			WorldTransforms[j] = Transform;
			AppliedParentTransforms[j] = true;
		}
		*/
		
		return WorldTransforms;
	}
};









//	stupid magic numbers
const GL_UNSIGNED_BYTE = 5121;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const GL_FLOAT = 5126;

function GetTypedArrayTypeFromAccessorType(Accessor)
{
	switch(Accessor.componentType)
	{
		case GL_UNSIGNED_BYTE:	return Uint8Array;
		case GL_UNSIGNED_SHORT:	return Uint16Array;
		case GL_UNSIGNED_INT:	return Uint32Array;
		case GL_FLOAT:			return Float32Array;
	}
	
	switch(Accessor.type)
	{
		case 'MAT4':
		case 'VEC2':
		case 'VEC3':
		case 'VEC4':
		case 'SCALAR':
			return Float32Array;
	}
	
	throw `Cannot determine array type from Accessor ${JSON.stringify(Accessor)}`;
}

function GetElementCountFromAccessorType(Accessor)
{
	switch(Accessor.type)
	{
		case 'MAT4':	return 4*4;
		case 'VEC2':	return 2;
		case 'VEC3':	return 3;
		case 'VEC4':	return 4;
		
		//	gr: is this always the case...
		case 'SCALAR':	return 1;
	}
	
	throw `Cannot determine element count from Accessor ${JSON.stringify(Accessor)}`;
}


//	from PopEngine/PopApi.js
export function StringToBytes(Str,AsArrayBuffer=false)
{
	//	https://stackoverflow.com/questions/6965107/converting-between-strings-and-arraybuffers
	if ( TextEncoder !== undefined )
	{
		const Encoder = new TextEncoder("utf-8");
		const Bytes = Encoder.encode(Str);
		return Bytes;
	}
	
	let Bytes = [];
	for ( let i=0;	i<Str.length;	i++ )
	{
		const CharCode = Str.charCodeAt(i);
		if ( CharCode >= 128 )
			throw `Pop.StringToBytes(${Str.substr(i,10)}) has non-ascii char`;
		Bytes.push(CharCode);
	}
	
	if ( AsArrayBuffer )
		Bytes = new Uint8Array(Bytes);
	return Bytes;
}
	

function Base64ToBytes(Base64)
{
	//	gr: is this a js built-in (for native), or web only?
	//		in which case we need an alternative maybe
	const DataString = atob(Base64);
	//	convert from the char-data-string to u8 array
	const Data = StringToBytes(DataString);
	//const Data = Uint8Array.from(DataString, c => c.charCodeAt(0));
	return Data;
}

//	return false if not a data URI
//	else returns a "File" with .Contents (u8array) and .Mime
//	gr: doesn't need to be async, but lets thread breath
const DataUriPattern = '^data:(.+)/(.+);base64,';
async function ParseDataUri(Uri)
{
	//	get a substring to test against to make the match much faster
	const UriStart = Uri.substring(0,200);	//	probably wont get a mime 200 chars long
	//console.log(`ParseDataUri(${UriStart})`);
	const Match = UriStart.match(DataUriPattern);
	if ( !Match )
		return false;

	//	grab everything after the datauri prefix	
	const DataBase64 = Uri.slice( Match[0].length );
	const Data = Base64ToBytes(DataBase64);
	
	const File = {};
	File.Mime = `${Match[1]}/${Match[2]}`;
	File.Contents = Data;
	return File;
}

//	GLB is a chunk binary file containing json + bin
//	todo: would be nice to be able to stream this blob
//	https://docs.fileformat.com/3d/glb/
class Glb_t
{
	static BinaryGltfMagic = 0x46546C67;	//	'glTF'
	static ChunkType_Json = 0x4E4F534A;		//	'JSON'
	static ChunkType_Bin = 0x004E4942;		//	'/0BIN'

	#Chunks = {};	//	[ChunkType] = Bin Data
	#Gltf = null;	//	parsed gltf Json

	
	constructor(GlbData)
	{
		//	verify data
		if ( ! (GlbData instanceof Uint8Array) )
			throw `Glb expecting uint8array data`;
		
		this.ArrayBuffer = GlbData.buffer;
		this.ReadPosition = 0;
		this.FileSize = null;		//	read from header
		this.Version = null;		//	read from header
		
		this.#ReadHeader();
		this.#ReadChunks();
	}
	
	get Gltf()	{	return this.#Gltf;	}
	
	#BytesRemaining()
	{
		return this.ArrayBuffer.byteLength - this.ReadPosition;
	}
	
	#ReadView(Size,TypedArrayType=Uint8Array)
	{
		const Remaining = this.#BytesRemaining();
		if ( Remaining < Size )
			throw `Reading out of bounds ${this.ReadPosition}+${Size} > ${this.ArrayBuffer.byteLength} (${Remaining} remaining)`;
		
		const Length = Size / TypedArrayType.BYTES_PER_ELEMENT;
		const View = new TypedArrayType( this.ArrayBuffer, this.ReadPosition, Length );
		this.ReadPosition += Size;
		return View;
	}
	
	#Read32()
	{
		const View32 = this.#ReadView(4,Uint32Array);
		return View32[0];
	}
	
	#ReadHeader()
	{
		const Magic = this.#Read32();
		if ( Magic != Glb_t.BinaryGltfMagic )
			throw `Magic number of GLB is incorrect (${Magic})`;
		
		this.Version = this.#Read32();
		
		//	file size should be header + all chunks
		this.FileSize = this.#Read32();
	}
	
	#GetChunkTypeName(Type)
	{
		switch ( Type )
		{
			case Glb_t.ChunkType_Json:	return 'Json';
			case Glb_t.ChunkType_Bin:	return 'Bin';
			default:
				return `${Type}`;
		}
	}
	
	#ReadNextChunk()
	{
		//	read length
		const ChunkSize = this.#Read32();
		const Type = this.#Read32();
		const TypeName = this.#GetChunkTypeName(Type);
		const Data = this.#ReadView( ChunkSize, Uint8Array );

		if ( this.#Chunks.hasOwnProperty(Type) )
			throw `Glb has duplicate chunk type ${TypeName}`;
		
		this.#Chunks[Type] = Data;
	}
	
	#ReadChunks()
	{
		//	safety
		for ( let i=0;	i<1000;	i++ )
		{
			if ( this.#BytesRemaining() <= 0 )
				break;

			this.#ReadNextChunk();
		}

		//	parse gltf json
		const JsonChunk = this.#Chunks[Glb_t.ChunkType_Json];
		const Json = new TextDecoder().decode(JsonChunk);
		this.#Gltf = new Gltf_t( Json );
	}
	
	//	expecting url to be blank in our case
	async #LoadBinaryFileAsync(Url)
	{
		const BinChunk = this.#Chunks[Glb_t.ChunkType_Bin];
		if ( !BinChunk )
			throw `Glb missing binary chunk`;

		return BinChunk;
	}
	
	async LoadBuffers(ExternalLoadBinaryFileAsync,OnLoadingBuffer)
	{
		return await this.#Gltf.LoadBuffers( this.#LoadBinaryFileAsync.bind(this), OnLoadingBuffer );
	}
	
	ExtractMeshes()
	{
		return this.#Gltf.ExtractMeshes();
	}
}

class Gltf_t
{
	constructor(Json)
	{
		if ( typeof Json == typeof '' )
			Json = JSON.parse( Json );

		Object.assign(this,Json);
		
		this.Geometrys = {};		//	[MeshName] = Mesh
		this.MeshGroups = {};	//	[GroupIndex] = {.Name,.GeometryNames = [GeometryName,GeometryName,GeometryName] }
	}
	
	async LoadBuffers(LoadBinaryFileAsync,OnLoadingBuffer)
	{
		OnLoadingBuffer = OnLoadingBuffer||function(){};
		
		for ( let Buffer of this.buffers )
		{
			if ( Buffer.Data )
				continue;
			
			const Uri = Buffer.uri || '';
			//	slice incase it's a datauri and a bit long
			OnLoadingBuffer( Uri.slice(0,40) );

			//	load embedded data without using external func
			Buffer.Data = await ParseDataUri(Uri);
			
			//	is external
			if ( !Buffer.Data )
			{
				Buffer.Data = await LoadBinaryFileAsync(Uri);
			}
			else
			{
				Buffer.Data = Buffer.Data.Contents;
			}
			
			//	hold data as a byte array
			if ( Buffer.Data instanceof ArrayBuffer )
				Buffer.Data = new Uint8Array(Buffer.Data);
		}
	}
	
	#UnrollInterleavedData(Data,StructBytes,StructByteOffset,OutputArrayType,OutputElementCount)
	{
		if ( ! (Data instanceof Uint8Array) )
			throw `Unrolling data expects uint8 data`;
		
		const InstanceOverflow = Data.byteLength % StructBytes;
		if ( InstanceOverflow != 0 )
			throw `Unrolling mis-aligned data`;
		
		const InstanceCount = Data.byteLength / StructBytes;
		
		//	walk over data
		const Output = new OutputArrayType(InstanceCount * OutputElementCount);
		for ( let i=0;	i<InstanceCount;	i++ )
		{
			let ByteOffset = i * StructBytes;
			ByteOffset += Data.byteOffset;
			ByteOffset += StructByteOffset;
			const ViewLength = OutputElementCount;
			const CastView = new OutputArrayType( Data.buffer, ByteOffset, ViewLength );
			Output.set( CastView, i * OutputElementCount );
		}
		return Output;
	}
	
	GetArrayAndMeta(AccessorIndex)
	{
		const Accessor = this.accessors[AccessorIndex];
		const BufferViewIndex = Accessor.bufferView;
		const BufferView = this.bufferViews[BufferViewIndex];
		const BufferIndex = BufferView.buffer;
		const Buffer = this.buffers[BufferIndex];
		
		Accessor.byteOffset = Accessor.byteOffset||0;
		BufferView.byteOffset = BufferView.byteOffset||0;
		BufferView.byteStride = BufferView.byteStride||0;	//	if undefined, no gaps between
		
		//	buffer.data.buffer here is the underlying storage, but this may not start at 0
		//	so always use Buffer.Data as our reference
		//const BufferData = Buffer.Data.buffer;
		//if ( !BufferData )
		//	throw `Buffer is missing data buffer`;
		const Offset = BufferView.byteOffset + Accessor.byteOffset + Buffer.Data.byteOffset;
		const ByteLength = BufferView.byteLength;

		//	get type from accessor
		const ArrayType = GetTypedArrayTypeFromAccessorType(Accessor);
		const ElementCount = GetElementCountFromAccessorType(Accessor);
		
		//	handle interleaved data
		let BufferViewStride = BufferView.byteStride;
		//	gr: if this stride is the same size as elements * size
		//		then it's not interleaved
		if ( BufferViewStride == ElementCount * ArrayType.BYTES_PER_ELEMENT )
			BufferViewStride = 0;
		
		
		//	hack for now until the renderer handles interleaved, non-float aligned (ie, mix of float and other types) attribute data
		if ( BufferViewStride != 0 )
		{
			//	gr: i think maybe the view in gltf is clipped to this element, rather than the stride-aligned buffer size
			//		to get to the total number of elements (all data/stride) we need to pad the view
			//	note: how this doesn't include the accessor offset!
			const CompleteDataOffset = BufferView.byteOffset + Buffer.Data.byteOffset;
			const CompleteDataSize = BufferView.byteLength;
			const StrideCompleteData = new Uint8Array( Buffer.Data.buffer, CompleteDataOffset, CompleteDataSize );
			const UnrolledData = this.#UnrollInterleavedData( StrideCompleteData, BufferViewStride, Accessor.byteOffset, ArrayType, ElementCount );
			
			const Meta = {};
			Meta.ElementSize = ElementCount;
			Meta.Stride = 0;
			
			if ( Meta.ElementSize < 1 || Meta.ElementSize > 4 )
				throw `Attrib element size(${Meta.ElementSize}) should be between 1 and 4`;
			
			const Result = {};
			Result.Array = UnrolledData;
			Result.Meta = Meta;
			return Result;
		}
		
		
		
		//	gr: acessor length is correct... IF the data isnt interleaved
		const BufferLength = BufferView.byteLength / ArrayType.BYTES_PER_ELEMENT;
		const AccessorLength = Accessor.count * ElementCount;

		//const Length = BufferLength;
		//	these only align if data is striped
		if ( AccessorLength != BufferLength )
			if ( BufferViewStride == 0 )
			console.log(`AccessorLength=${AccessorLength} BufferLength=${BufferLength}`);

		//	gr: this mapping to a type is wrong if data is interleaved
		const Array = new ArrayType( Buffer.Data.buffer, Offset, AccessorLength );
		
		//	this checks the array, but not this accessor
		//	https://github.com/KhronosGroup/glTF-Tutorials/blob/main/gltfTutorial/gltfTutorial_005_BuffersBufferViewsAccessors.md
		//	The count property of an accessor indicates how many data elements it consists of.
		{
			/*
			const Overflow = Array.length % Accessor.count;
			if ( Overflow )
				throw `Accessor vs buffer data mis-aligned; length=${Array.length} count=${Accessor.count}`;
			 */
		}
		
		//	stride = buffer stride - (elementsize * type.bytesize) 
		
		const Meta = {};
		Meta.ElementSize = ElementCount;
		Meta.Stride = BufferViewStride;	//	bytes
		
		if ( Meta.ElementCount < 1 || Meta.ElementCount > 4 )
			throw `Attrib element size(${Meta.ElementSize}) should be between 1 and 4`;
		
		const Result = {};
		Result.Array = Array;
		Result.Meta = Meta;
		return Result;
	}
	
	PushGeometry(Geometry,MeshGroupIndex)
	{
		const MeshGroup = this.MeshGroups[MeshGroupIndex];
		if ( !MeshGroup )
			throw `PushGeometry to MeshGroupIndex=${MeshGroupIndex} but MeshGroup=${MeshGroup}`; 
			
		//	todo; generate truly unique mesh name
		const GeometryCount = MeshGroup.GeometryNames.length;
		const GeometryName = `${MeshGroup.Name}_${GeometryCount}`;
		if ( this.Geometrys[GeometryName] )
			throw `Geometry with name ${GeometryName} already exists`;
		this.Geometrys[GeometryName] = Geometry;
		MeshGroup.GeometryNames.push(GeometryName);	
	}
	
	ExtractMeshes()
	{
		function PrimitiveToMesh(PrimitivesDescription)
		{
			const Mesh = {};
			Mesh.Material = PrimitivesDescription.material;
			Mesh.TriangleIndexes = null;
			
			if ( PrimitivesDescription.indices !== undefined )
			{
				const Indexes = this.GetArrayAndMeta(PrimitivesDescription.indices);
				Mesh.TriangleIndexes = Indexes.Array;
			}
			Mesh.Attribs = {};
			
			let VertexCount = null;			
			for ( const [AttributeName,AttributeIndex] of Object.entries(PrimitivesDescription.attributes) ) 
			{
				const ArrayAndMeta = this.GetArrayAndMeta(AttributeIndex);
				const Attrib = {};
				Attrib.Data = ArrayAndMeta.Array;
				Attrib.Size = ArrayAndMeta.Meta.ElementSize;
				Attrib.Stride = ArrayAndMeta.Meta.Stride; 
				Mesh.Attribs[AttributeName] = Attrib;
				const AttribVertexCount = Attrib.Data.length / Attrib.Size;
				//console.log(`${AttributeName} vertex count ${AttribVertexCount} vs ${VertexCount}`);
				if ( !VertexCount )
					VertexCount = AttribVertexCount;
			}
			return Mesh;
		}

		//	meshes are collections of primitives (with their own materials)
		//	so a mesh is a group of meshes
		for ( let MeshGroupKey in this.meshes )
		{
			//	gr: I think we're expecting all these keys to be indexes
			let GroupIndex = parseInt(MeshGroupKey);
			if ( isNaN(GroupIndex) )
				throw `Mesh group key ${MeshGroupKey} is not a number`;
			
			let GroupName = this.meshes[GroupIndex].name;
			if ( !GroupName )	//	can be undefined
				GroupName = `Group#${GroupIndex}`;
				
			if ( this.MeshGroups[GroupIndex] )
				throw `Not expecting MeshGroup[${GroupIndex}] for ${GroupName} to exist`;
			
			//	a "mesh" is a group
			//	we need to record mesh-index -> group for later (material etc)
			this.MeshGroups[GroupIndex] = {};
			this.MeshGroups[GroupIndex].Name = GroupName;
			this.MeshGroups[GroupIndex].GeometryNames = [];

			const Meshes = this.meshes[GroupIndex].primitives.map( PrimitiveToMesh.bind(this) );
			for ( let Mesh of Meshes )
			{
				this.PushGeometry( Mesh, GroupIndex );
			}
		}
	}
	
	GetSkeleton(SkinIndex)
	{
		const Skin = this.skins[SkinIndex];
		if ( !Skin )
			throw `No skin #${SkinIndex}`;
		
		const SceneNodeIndexes = Skin.joints;
		
		//	this is an array of matrixes, one for each joint that converts world/geometry/skin-space to joint-space
		//	("inverse of joint to vertex")
		const InverseBindMatricesAccessorIndex = Skin.inverseBindMatrices;
		const InverseBindMatricesAccessor = this.accessors[InverseBindMatricesAccessorIndex];
		const WorldToJointMatrixDatas = this.GetArrayAndMeta(InverseBindMatricesAccessorIndex);
		
		const WorldToJointMatrixes = SplitArrayIntoChunks( WorldToJointMatrixDatas.Array, WorldToJointMatrixDatas.Meta.ElementSize );
		const JointToWorldMatrixes = WorldToJointMatrixes.map( MatrixInverse4x4 );
		

		
		function GetJointNodeMeta(NodeIndex)
		{
			if ( NodeIndex < 0 || NodeIndex >= this.nodes.length )
				throw `Node index ${NodeIndex}/${this.nodes.length} out of bounds`;
		
			const NodeMeta = Object.assign( {}, this.nodes[NodeIndex] );
			const JointIndex = SceneNodeIndexes.indexOf(NodeIndex);
			NodeMeta.WorldToJointTransform = WorldToJointMatrixes[JointIndex];
			NodeMeta.JointToWorldTransform = JointToWorldMatrixes[JointIndex];
			NodeMeta.NodeIndex = NodeIndex;
			//	index in this skin
			NodeMeta.JointIndex = JointIndex;
			NodeMeta.children = NodeMeta.children || [];
			return NodeMeta;
		}
		const Skeleton = new Skeleton_t( Skin.name, SceneNodeIndexes, GetJointNodeMeta.bind(this) );
		
		Skeleton.WorldToJointMatrixes = WorldToJointMatrixes;
		Skeleton.JointToWorldMatrixes = JointToWorldMatrixes;
		//	gr: we want these flattened and padded for the renderer
		
		const MaxJoints = 70;
		const WorldToJointMatrixesFlat = WorldToJointMatrixDatas.Array;
		const JointToWorldMatrixesFlat = new Float32Array( JointToWorldMatrixes.flat() );
		Skeleton.WorldToJointMatrixes = new Float32Array(MaxJoints*16);
		Skeleton.WorldToJointMatrixes.set( WorldToJointMatrixesFlat );
		Skeleton.JointToWorldMatrixes = new Float32Array(MaxJoints*16);
		Skeleton.JointToWorldMatrixes.set(JointToWorldMatrixesFlat);

		return Skeleton;
	}
	
	GetAnimationNames()
	{
		const Animations = this.animations || [];
		return Animations.map( a => a.name );
	}
	
	GetAnimation(AnimationName)
	{
		const Animations = (this.animations || []).filter( a => a.name == AnimationName );
		if ( Animations.length == 0 )
			throw `No such animation "${AnimationName}"`;
		if ( Animations.length > 1 )
			throw `Multiple(${Animations.length}) animations named "${AnimationName}"`;
		const Animation = Animations[0];
		
		function GetNodeMeta(NodeIndex)
		{
			return this.nodes[NodeIndex];
		}
		
		return new AnimationClip( Animation, GetNodeMeta.bind(this), this.GetArrayAndMeta.bind(this) );
	}
}

async function GetGltfExtractor(GltfData,LoadBinaryFileAsync,OnLoadingBuffer)
{
	try
	{
		const Glb = new Glb_t( GltfData );
		return Glb;
	}
	catch(e)
	{
		console.log(`Is not GLB; ${e}`);
	}

	//	convert input to string then json->obj
	const GltfJson = new TextDecoder().decode(GltfData);
	
	const Gltf = new Gltf_t(GltfJson);
	
	return Gltf;
}

export default async function Parse(GltfData,LoadBinaryFileAsync,OnLoadingBuffer)
{
	const Gltf = await GetGltfExtractor( GltfData, LoadBinaryFileAsync, OnLoadingBuffer );
	
	//	load external buffers
	await Gltf.LoadBuffers(LoadBinaryFileAsync,OnLoadingBuffer);
	
	Gltf.ExtractMeshes();
	
	if ( Gltf instanceof Glb_t )
		return Gltf.Gltf;
	else
		return Gltf;
}


