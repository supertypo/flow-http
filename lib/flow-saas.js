const path 	= require("path");
const fs 	= require("fs");
const http = require('http');
const https = require('https');
const EventEmitter = require("events");
const express = require('express');


//const utils = require("@aspectron/flow-utils");

class FlowSaasApp extends EventEmitter{
	constructor(options={}){
		super();
		this.initLog();
		this.options = Object.assign({}, this.defaultOptions, options);
		this.init();
	}

	init(){
		this.initConfig();
		this.initHttp();
		/*this.initDB();*/
	}

	initConfig(){
		this.config = {}
		let {configFile} = this.options;
		if(!fs.existsSync(configFile))
			return

		let content = fs.readFileSync(configFile).toString();
		if(!content)
			return
		this.config = eval(`(${content})`);
		//this.log("this.config", JSON.stringify(this.config, null, 4));
	}

	initHttp(){
		let {http:httpConfig} = this.config;
		if(!httpConfig)
			return
		let {port, host, ssl} = httpConfig;
		this.app = express();
		this.initApp(this.app);

		let cb = ()=>this.log(`listening at http${ssl?'s':''}://${host}:${port}`);
		
		if(ssl){
			let {keyFile, certFile} = httpConfig;
			if(!keyFile || !fs.existsSync(keyFile))
				throw new Error("https server keyFile dont exists.")
			if(!certFile || !fs.existsSync(certFile))
				throw new Error("https server certFile dont exists.")
			const options = {
				key: fs.readFileSync(keyFile),
				cert: fs.readFileSync(certFile)
			};
			https.createServer(options, this.app).listen(port, host, cb)
		}else{
			http.createServer(this.app).listen(port, host, cb);
		}
	}

	/*
	initDB(){
		let {database} = this.config;
		if(!database)
			return


	}
	*/

	initApp(app){
		app.get("/", (req, res)=>{
			res.send("Hello world");
		})
	}

	get defaultOptions(){
		let info = this.packageJSON;
		let ident = info.appIdent || info.name;
		return {
			ident,
			configFile:info.configFile||path.join(this.appFolder, `config/${ident}.conf`)
		}
	}

	get appFolder(){
		return process.cwd();
	}

	get packageJSON(){
		return require(path.join(this.appFolder, "package.json"));
	}

	initLog(){
		let name = this.constructor.name;
		let logPrefix = this.logPrefix || `[${name}]:`;
		this.log = console.log.bind(console, logPrefix)
	}
}

module.exports = FlowSaasApp