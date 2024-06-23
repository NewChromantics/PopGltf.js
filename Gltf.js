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
		//	temp to fix bugs: copy the data with no byte offset
		return BinChunk.slice();
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
		
		//	buffer.data.buffer here is the underlying storage, but this may not start at 0
		//	so always use Buffer.Data as our reference
		//const BufferData = Buffer.Data.buffer;
		//if ( !BufferData )
		//	throw `Buffer is missing data buffer`;
		const Offset = (BufferView.byteOffset || 0) + Accessor.byteOffset + Buffer.Data.byteOffset;
		const ByteLength = BufferView.byteLength;

		//	get type from accessor
		const ArrayType = GetTypedArrayTypeFromAccessorType(Accessor);
		const ElementCount = GetElementCountFromAccessorType(Accessor);
		
		//	handle interleaved data
		let BufferViewStride = BufferView.byteStride || 0;	//	if undefined, no gaps between
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
			const CompleteDataOffset = (BufferView.byteOffset || 0) + Buffer.Data.byteOffset;
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


