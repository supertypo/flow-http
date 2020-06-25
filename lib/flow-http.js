const path 	= require("path");
const fs 	= require("fs");
const http = require('http');
const https = require('https');
const EventEmitter = require("events");
const crypto = require("crypto");

const utils = require("./utils");

class FlowHttp extends EventEmitter{
	constructor(options={}){
		super();
		this.initLog();
		this.pkg = require(path.join(this.appFolder, "package.json"));
		this.options = Object.assign({}, this.defaultOptions, options);
		this._log = {
	        'INFO' : 1,
	        'WARN' : 2,
	        'DEBUG' : 3
	    }
	}

	async init(){
		await this._init();
	}
	_init(){
		this.initConfig();

		let steps = [];

		let {config} = this;
		config.certificates && steps.push(this.initCertificates);
		steps.push(this.initHttp.bind(this));

		let index = 0;
		return new Promise((resolve, reject)=>{
			let next = (err)=>{
				if(err)
					return reject(err);

				let step = steps.shift();
				if(!step)
					return resolve();

				this.verbose && this.log("step", `[${index++}]`, step.name)
				if(!(step instanceof Promise)){
					//console.log("!instanceof Promise", step)
					step = step(next);
					if(!(step instanceof Promise))
						return
				}
				step.then(next, reject);
			}

			next();
		}).then(()=>{

		}, (err)=>{
			this.log("INIT:error", err)
		})
	}

	initConfig(){
		this.config = {}
		let {configFile, config} = this.options;
		if(config){
			this.config = config;
			return;
		}
		if(!configFile || !fs.existsSync(configFile))
			return
		this.config = utils.getConfig(configFile);
		//this.log("this.config", JSON.stringify(this.config, null, 4));
	}

	initHttp(){
		return new Promise((resolve, reject)=>{
			let {config} = this;
			let {http:httpConfig} = config;
			if(!httpConfig)
				return

			let {port, host, ssl} = httpConfig;
			
			this.initExpressApp();
			this.initApp(this.app);
			this.initStaticFiles();

			http.globalAgent.maxSockets = config.maxHttpSockets || 1024;
			https.globalAgent.maxSockets = config.maxHttpSockets || 1024;

			let CERTIFICATES = ssl && this.certificates;

			let args = [ ]
			args.push(port);
			host && args.push(host);

			args.push(err=>{
				if(err){
					console.error(`Unable to start HTTP(S) server on port ${port}  ${host?" host '"+host+"'":''}`);
					return reject(err);
				}

				this.log(`HTTP server listening on port ${(port+'').bold}  ${host?" host '"+host+"'":''}`);

				if (!CERTIFICATES)
					this.log(("WARNING - SSL is currently disabled").yellow.bold);

				this.emit('init::http-server')
				resolve();
			})

			let server;
			if(CERTIFICATES){
				server = https.createServer(CERTIFICATES, this.app)
				this._isSecureServer = true;
			}else{
				server = http.createServer(this.app)
			}
			this.server = server;
			server.listen.apply(server, args);
			
		})
	}

	initExpressApp(){
		let {config} = this;
		let {express} = FlowHttp.modules;
		if(typeof express!= 'function')
			throw new Error("flow-http.FlowHttp requires express module.");
		let app = express();
		this.app = app;
		this.express = express;
		this.initSession(app);

		//let {sessionSecret} = this;
		//sessionSecret && app.use(require('cookie-parser')(sessionSecret));
	}

	initStaticFiles(){
		if(!this.config.staticFiles)
			return
		let ServeStatic = this.express.static;
		utils.each(this.config.staticFiles, (dst, src)=>{
			console.log('HTTP serving '+src.cyan.bold+' -> '+dst.cyan.bold);
			this.app.use(src, ServeStatic(path.join(this.appFolder, dst)));
		})
	}

	initCertificates(){
		if(this.verbose)
			console.log('iris-app: loading certificates from ', this.appFolder+'/'+this.config.certificates);
		if(this.certificates) {
			console.error("Warning! initCertificates() is called twice!".redBG.bold);
			return;
		}

		let {config} = this;
		let ca_chain;
		if(typeof(config.certificates) == 'string') {
			this.certificates = {
				key: fs.readFileSync(this.locateCertificateFile(config.certificates+'.key')).toString(),
				cert: fs.readFileSync(this.locateCertificateFile(config.certificates+'.crt')).toString(),
				ca: [ ]
			}
			ca_chain = config.certificates+'.ca';
		}else{
			this.certificates = {
				key: fs.readFileSync(this.locateCertificateFile(config.certificates.key)).toString(),
				cert: fs.readFileSync(this.locateCertificateFile(config.certificates.crt)).toString(),
				ca: [ ]
			}
			ca_chain = config.certificates.ca;
		}

		if(ca_chain) {
			let ca_chain_file = this.locateCertificateFile(ca_chain, true);

			if(ca_chain_file) {
				let cert = [ ]
				let chain = fs.readFileSync(ca_chain_file).toString().split('\n');
				chain.forEach(line=>{
					cert.push(line);
					if(line.match('/-END CERTIFICATE-/')) {
						this.certificates.ca.push(cert.join('\n'));
						cert = [ ]
					}
				})
			}
		}
	}
	locateCertificateFile(filename, ignore) {
		let file = path.join(appFolder, filename);
		let parts = file.split('.');
		parts.splice(parts.length-1, 0, '.local');
		let local = parts.join();
		if(fs.existsSync(local))
			return local;
		if(!ignore && !fs.existsSync(file)) {
			this.log("Unable to locate certificate file:".red.bold, file.bold);
			throw new Error("Unable to locate certificate file");
		}
		else if(ignore && !fs.existsSync(file))
			return null;

		return file;
	}

	buildSessionOptions(){
		return false;
	}

	initSession(app){
		let options = this.buildSessionOptions();
		if(options){
			this.sessionSecret = options.secret;
			this.sessionKey = options.name;
			this.sessionStore = options.store;
			app.use(FlowHttp.modules.session(options));
			//this.log("sessionStore", this.sessionStore)
		}
	}

    getSessionById(sid){
    	return new Promise((resolve, reject)=>{
	        if(!this.sessionStore)
	            return reject({error: "Session not initilized."});

	        this.sessionStore.get(sid, (err, session)=>{
	            if (!session || err)
	                return reject(err);

	            session.id = sid;

	            resolve(session);
	        });
	    })
    }

	initApp(app){
		app.get("/", (req, res)=>{
			res.send("Hello world");
		})
	}

	get defaultOptions(){
		let pkg = this.pkg;
		let ident = pkg.appIdent || pkg.name;
		return {
			ident,
			configFile:path.join(this.appFolder, `config/${ident}.conf`)
		}
	}

	get appFolder(){
		return process.cwd();
	}

	initLog(){
		let name = this.constructor.name;
		let logPrefix = this.logPrefix || `[${name}]:`;
		this.log = console.log.bind(console, logPrefix)
	}
}

module.exports = FlowHttp
