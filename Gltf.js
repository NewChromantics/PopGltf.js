//	stupid magic numbers
const GL_UNSIGNED_SHORT = 5123;
const GL_FLOAT = 5126;

function GetTypedArrayTypeFromAccessorType(Accessor)
{
	switch(Accessor.componentType)
	{
		case GL_UNSIGNED_SHORT:	return Uint16Array;
		case GL_FLOAT:			return Float32Array;
	}
	
	switch(Accessor.type)
	{
		case 'MAT4':
		case 'VEC2':
		case 'VEC3':
		case 'VEC4':
			return Float32Array;
	}
	
	throw `Cannot determine array type from Accessor ${JSON.stringify(Accessor)}`;
}


class Gltf_t
{
	constructor(Json)
	{
		Object.assign(this,Json);
		
		this.Geometrys = {};		//	[MeshName] = Mesh
		this.MeshGroups = {};	//	[GroupIndex] = {.Name,.GeometryNames = [GeometryName,GeometryName,GeometryName] }
	}
	
	async LoadBuffers(LoadBinaryFileAsync)
	{
		for ( let Buffer of this.buffers )
		{
			if ( Buffer.Data )
				continue;
			Buffer.Data = await LoadBinaryFileAsync(Buffer.uri);
		}
	}
	
	GetArrayAndMeta(BufferViewIndex)
	{
		const BufferView = this.bufferViews[BufferViewIndex];
		const BufferIndex = BufferView.buffer;
		const Buffer = this.buffers[BufferIndex];
		const BufferData = Buffer.Data.buffer;
		const Offset = BufferView.byteOffset || 0;
		const ByteLength = BufferView.byteLength;
		
		function MatchAccessor(Accessor)
		{
			return Accessor.bufferView == BufferViewIndex;
		}
		const Accessor = this.accessors.find(MatchAccessor);
		if ( !Accessor )
			throw `Failed to find accessor for BufferViewIndex=${BufferViewIndex}`;
	
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
	
	PushGeometry(Geometry,GroupName,GroupIndex)
	{
		//	a "mesh" is a group
		//	we need to record mesh-index -> group
		if ( !this.MeshGroups[GroupIndex] )
		{
			this.MeshGroups[GroupIndex] = {};
			this.MeshGroups[GroupIndex].Name = GroupName;
			this.MeshGroups[GroupIndex].GeometryNames = [];
		}
			
		const MeshGroup = this.MeshGroups[GroupIndex];
			
		//	todo; generate truly unique mesh name
		const GeometryCount = MeshGroup.GeometryNames.length;
		const GeometryName = `${GroupName}_${GeometryCount}`;
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
			
			if ( PrimitivesDescription.indices )
			{
				const Indexes = this.GetArrayAndMeta(PrimitivesDescription.indices);
				Mesh.TriangleIndexes = Indexes.Array;
			}
			Mesh.Attribs = {};
			
			const TriangleCount = Mesh.TriangleIndexes.length / 3;
			let VertexCount;
			
			for ( const [AttributeName,AttributeIndex] of Object.entries(PrimitivesDescription.attributes) ) 
			{
				const ArrayAndMeta = this.GetArrayAndMeta(AttributeIndex);
				const Attrib = {};
				Attrib.Data = ArrayAndMeta.Array;
				Attrib.Size = ArrayAndMeta.Meta.ElementSize;
				Mesh.Attribs[AttributeName] = Attrib;
				const AttribVertexCount = Attrib.Data.length / Attrib.Size;
				console.log(`${AttributeName} vertex count ${AttribVertexCount} vs ${VertexCount}`);
				if ( !VertexCount )
					VertexCount = AttribVertexCount;
			}
			return Mesh;
		}

		//	meshes are collections of primitives (with their own materials)
		//	so a mesh is a group of meshes
		for ( let GroupIndex in this.meshes )
		{
			const GroupName = this.meshes[GroupIndex].name;
			const Meshes = this.meshes[GroupIndex].primitives.map( PrimitiveToMesh.bind(this) );
			for ( let Mesh of Meshes )
			{
				this.PushGeometry( Mesh, GroupName, GroupIndex );
			}
		}
	}
}

export default async function Parse(Json,LoadBinaryFileAsync)
{
	//	if user passes a string, objectify it
	if ( typeof Json == typeof '' )
		Json = JSON.parse(Json);
	
	let Gltf = new Gltf_t(Json);
	
	//	load external buffers
	await Gltf.LoadBuffers(LoadBinaryFileAsync);
	
	Gltf.ExtractMeshes();
	
	return Gltf;
}


