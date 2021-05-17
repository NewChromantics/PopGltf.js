What?
-----
This is a js-module GLTF loader which
- Doesn't assume you're using/need webgl
- Doesn't need building (not .ts, not minified) so can be used as submodule or from CDN
- Is async
- Expects you to handle data loading (Provide the file json, and async functors to load binaries & images)
- Is in module format.
- Doesn't reformat all the data into some proprietry scene/mesh format/layout
- Is NOT a renderer.

Why?
----
The GLTF format is pretty simple for Javascript to parse, a lot of libraries IMO are overly-complex, or have huge amounts of dependencies, or I just can't easily include them into a build-less project.

How?
---
```
import Gltf from './PopGltf.js'
const GltfJson = <your json>
const GltfScene = await Gltf.Load( GltfJson, YourAsyncBinaryFileLoader );
```
