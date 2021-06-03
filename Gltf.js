//	stupid magic numbers
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const GL_FLOAT = 5126;

function GetTypedArrayTypeFromAccessorType(Accessor)
{
	switch(Accessor.componentType)
	{
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
			return Float32Array;
			
		//case 'SCALAR':
	}
	
	throw `Cannot determine array type from Accessor ${JSON.stringify(Accessor)}`;
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



class Gltf_t
{
	constructor(Json)
	{
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
				
			OnLoadingBuffer( Buffer.uri.slice(0,40) );

			//	load embedded data without using external func
			Buffer.Data = await ParseDataUri(Buffer.uri);
			
			//	is external
			if ( !Buffer.Data )
			{
				Buffer.Data = await LoadBinaryFileAsync(Buffer.uri);
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
	
	GetArrayAndMeta(AccessorIndex)
	{
		const Accessor = this.accessors[AccessorIndex];
		const BufferViewIndex = Accessor.bufferView;
		const BufferView = this.bufferViews[BufferViewIndex];
		const BufferIndex = BufferView.buffer;
		const Buffer = this.buffers[BufferIndex];
		const BufferData = Buffer.Data.buffer;
		if ( !BufferData )
			throw `Buffer is missing data buffer`;
		const Offset = BufferView.byteOffset || 0;
		const ByteLength = BufferView.byteLength;
		
		//	get type from accessor
		const ArrayType = GetTypedArrayTypeFromAccessorType(Accessor);
		
		const Length = BufferView.byteLength / ArrayType.BYTES_PER_ELEMENT;
		const Array = new ArrayType( BufferData, Offset, Length );
		
		{
			const Overflow = Array.length % Accessor.count;
			if ( Overflow )
				throw `Accessor vs buffer data mis-aligned; length=${Array.length} count=${Accessor.count}`;
		}
		
		const Meta = {};
		Meta.ElementSize = Array.length / Accessor.count;
		
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

export default async function Parse(Json,LoadBinaryFileAsync,OnLoadingBuffer)
{
	//	if user passes a string, objectify it
	if ( typeof Json == typeof '' )
		Json = JSON.parse(Json);
	
	let Gltf = new Gltf_t(Json);
	
	//	load external buffers
	await Gltf.LoadBuffers(LoadBinaryFileAsync,OnLoadingBuffer);
	
	Gltf.ExtractMeshes();
	
	return Gltf;
}


