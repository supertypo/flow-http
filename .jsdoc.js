//const pkg = require("./package.json");
module.exports = {
    "source": {
        "include": [
            "package.json", "README.md", "index.js", "lib"
        ],
        "includePattern": ".js$",
        "excludePattern": "(node_modules/|docs)"
    },
    "plugins":[
        "plugins/markdown",
        "./node_modules/flow-jsdoc-template/category",
        "./node_modules/flow-jsdoc-template/cssvar"
    ],
    "opts": {
        "readme": "./README.md",
        "destination": "docs",
        "template": "./node_modules/flow-jsdoc-template"
    },
    "templates": {
        "name": "Flow HTTP Server"
    }
}