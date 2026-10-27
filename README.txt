
Human-Human communication is de facto a linear sequence of events: starting pre-historically as streams of verbal utterances, we told stories to each other; as writing evolved, we shared sequences of symbols interpreted as literature; and in the present digital age, we show linear sequences of ideas to one another in videos and PowerPoint slides. The linear sequence is really however just a projected path from the full graph of ideas stored in our minds, and that is the true fundamental object.

A complex topic that can be described by many different linear stories is compactly represented by such a graph. 
As a suggested structural schema, we propose:


knowledge.json
├── schemaVersion
├── document
│   ├── id
│   ├── title
│   ├── description
│   ├── language
│   └── meta
├── graph
│   ├── rootNodeId
│   ├── nodes[]
│   │   ├── id
│   │   ├── name
│   │   ├── weight
│   │	├── description
│   │	├── icon
│   │   ├── position (optional)
│   │   ├── content[]
│   │   │   ├── id
│   │	│   ├── name
│   │  	│   ├── weight
│   │   │   ├── type
│   │   │   └── type-specific properties
│   │   │        ├──title
│   │   │        ├──notes
│   │   │        ├──source url
│   │   │        └──icon
│   │   └── hints (optional)
│   └── edges{}
│       ├── key: source
│           value: {key:target, value: { weight, relation(optiona)}}
└── extensions
    └── renderer-specific properties


There are several examples of the above in JSON format in the examples/ directory.
In addition, the renderer/ directory contains specific rendering engines to display and navigate graphs in the above schema.
