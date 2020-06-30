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
	async _init(){
		this.initConfig();

		if(this.config.certificates)
			await this.initCertificates();
		await this.initHttp(this);
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
			this.emit("init::app", {app:this.app});
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

				this.emit('init::http-server', {server:this.server})
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

			// ---

			// @surinder - let's do the same with a pure WS
			const { socketio } = FlowHttp.modules;
			if(socketio) {

				server.on("upgrade", (req, socket, head) => {
					/*/console.log("socket upgrade".red, socket)
					var _write = socket.write;
					socket.write = function(a){
						console.log("a$$$".redBG, a+"")
						_write.apply(socket, arguments);
					}
					*/
		
					this.io.engine.ws.once("headers", headers=>{
						//console.log("a#########".redBG, headers)
						let sessionCookie = this.buildSesssionCookie(req, headers);
						if(sessionCookie)
							headers[headers.length] = "Set-Cookie: "+sessionCookie;
					})
				})
				this.io = socketio.listen(server, {
					'log level': 0,
					'secure': CERTIFICATES ? true : false,
					allowRequest:(req, fn)=>{
						if(this.config.handleWSSession) {
							this.allowWSRequest(req, fn);
						} else {
							fn(null, true);
						}
					}
				});

				if(this.config.websocketPath)
					this.init_socketio_handler(this.config.websocketPath);
			}

			server.listen.apply(server, args);
			
		}).then(()=>{

		}, (err)=>{
			this.log("initHttp:err", err)
		})
	}
	buildSesssionCookie(req){
		let {Cookie, CookieSignature} = FlowHttp.modules;
        if(!Cookie || !CookieSignature || !req.session || !req.sessionID)
            return false;

        let cookieName          = this.getHttpSessionCookieName();
        let signed              = 's:'+CookieSignature.sign(req.sessionID, this.getHttpSessionSecret());

        return Cookie.serialize(cookieName, signed, req.session.cookie);
    }

	// !!! ##############################
	// !!! ##############################
	// !!! ##############################

	allowWSRequest(req, fn){
        let res = req.res;

        if(res){
            let _writeHead = res.writeHead;
            res.writeHead = (statusCode, statusMessage, headers)=>{
                if(!headers){
                    headers = statusMessage;
                    statusMessage = null;
                }

                headers = headers || {};

                let cookies = headers["Set-Cookie"] || [];
                if(!utils.isArray(cookies))
                    cookies = [cookies];

                let sessionCookie = this.buildSesssionCookie(req, headers);
                if(sessionCookie)
                    cookies.push(sessionCookie);
                //console.log("cookies".greenBG, cookies)

                headers["Set-Cookie"] = cookies;

                if(statusMessage)
                    _writeHead.call(res, statusCode, statusMessage, headers);
                else
                    _writeHead.call(res, statusCode, headers);
            }
        }else{
            res = {
                end(){

                }
            }
        }
        this.expressSession(req, res, ()=>{
            fn(null, true);
        })   
    }

    getSocketSession(socket) {
    	let {Cookie} = FlowHttp.modules;
    	if(!Cookie){
    		this.log("Cookie module is required for socket session")
    		return Promise.reject("Cookie module is required for socket session");
    	}

        let cookies = null;
        try{
            cookies = this.unsignCookies(
        		Cookie.parse(socket.handshake.headers.cookie||''),
        		this.getHttpSessionSecret()
            );
        }catch(ex){
            this.log("Cookie.parse:error", ex);
            return Promise.reject(ex);
        }

        let sid = cookies[ this.getHttpSessionCookieName() ];

		return this.getSessionById(sid);
    }

	init_socketio_handler(websocketPath) {
		const NAX_SUBSCRIPTIONS = 64;
		let socketsOpen = 0;
		this.websocketMap = new Map();
		this.subscriptionMap = new Map();
		this.pendingMap = new Map();
		this.default_nats_request_options = { max : 1 };

		this.websockets = this.io.of(websocketPath).on('connection', async (socket)=>{
			console.log("######## socket:init-1".redBG, socket.id)
			let session = await this.getSocketSession(socket)
			.then((session)=>{
				this.log("getSocketSession:session", session)
			}, (err)=>{
				this.log("getSocketSession:error", err)
			}).catch(err=>{
				this.log("getSocketSession:error", err)
			});
			console.log("#### socket:init-2".redBG, session)
			socket.session = session;
			socketsOpen++;
			let rids = 0;
			this.websocketMap.set(socket.id, socket);
			if(!this.subscriptionMap.has(socket.id))
				this.subscriptionMap.set(socket.id, []); 
			const subscriptions = this.subscriptionMap.get(socket.id);
			if(!this.pendingMap.has(socket.id))
				this.pendingMap.set(socket.id, new Map())
			const pending = this.pendingMap.get(socket.id);
			
			socket.emit('message', {
				subject : 'init', 
				// data : { 
				// 	uuid : core.uuid, 
				// 	name : core.pkg.name,
				// 	version : core.pkg.version,
				// 	hostname : os.hostname() 
				// } 
			});
			
			this.emit("websocket.connect", {socket});

			socket.on('disconnect', ()=>{
				this.websocketMap.delete(socket.id);
				while(subscriptions.length)
					this.nats.unsubscribe(subscriptions.shift());
				this.subscriptionMap.delete(socket.id);
				
				pending.forEach(cb=>{
					cb('disconnect');
				});

				pending.clear();

				socketsOpen--;
			});

			socket.on('response', (msg) => {
				let { resp, rid } = msg;
				if(pending.has(rid)) {
					let cb = pending.get(rid);
					pending.delete(rid);
					cb(null, resp);
				}					
			});

			socket.on('publish', (msg) => {
				// TODO - check token, reject or publish to NATS
				let { req : { subject, data, opt }, rid } = msg;

				if(!this.checkAuth(session.user, subject)) {
					socket.emit('publish::response', { rid, error: "Access Denied" });
					return;
				}

				this.nats.publish(subject,message);
				socket.emit('publish::response', { rid, ack : true });
			});

			// NATS subscribe
			socket.on('subscribe', (msg) => {
				// TODO - check token, reject or publish to NATS
				let { req : { subject, data, opt }, rid } = msg;

				if(!this.checkAuth(session.user, subject)) {
					socket.emit('subscribe::response', { rid, error: "Access Denied" });
					return;
				}

				if(subscriptions.length > NAX_SUBSCRIPTIONS) {
					socket.emit('subscribe::response', { rid, error: "Maximum Number of Subscriptions Reached" });
					return;
				}

				//this.nats.publish(subject,message);

				let ident = this.nats.subscribe(subject, (data, reply, subject, sid) => {
					if(reply) {

						const rid = rids++;
						socket.emit('request', { rid, req : { subject, data }});
						pending.set(rid, (error, data) => {
							if(error)
								this.nats.publish(reply, { error });
							else
								this.nats.publish(reply, data);
						})
						// const pending = this.pendingMap[socket.id]
						// this.pendingMap[socket.id]
						// this is a request to us...
						//this.nats.publish(reply, data)
					}

					socket.emit('publish', { subject, data });

				});


				subscriptions.push(ident);
				
				// if(this.rpc.acc_)
				// 	this.rpc.acc_.subscriptions.push(ident);
				//return ident;

				socket.emit('subscribe::response', { rid, ident });
			});

			// NATS request
			socket.on('request', (msg) => {

				let { req : { subject, data, opt }, rid } = msg;

				if(!this.checkAuth(session.user, subject) ){
					socket.emit('rpc::response', { rid, error: "Access Denied" });
					return;
				}

				if(!opt)
					opt = this.default_nats_request_options;

				// TODO - check token, reject or publish to NATS
				// const { subject, message, opt } = args;
				this.nats.request(subject, data, opt, (response) => {
					if(response.error) {
						console.log(`NATS error during subject '${subject}'`,response.error);
						socket.emit('response', { rid, error: response.error });
					}
					else
					if(response.code && response.code === NATS.REQ_TIMEOUT) {
						console.log(`NATS RPC request timed out - code: ${response.code} subject: ${subject}`);
						console.log(error.stack);
						socket.emit('response', { rid, error: `NATS RPC timeout code: ${response.code} subject: ${subject}` });
					}
					socket.emit('response', {
						data : response.data
					})
				})					
			});
			

			socket.on('rpc.req', async (msg) => {
				let { req : { subject, data }, rid } = msg;

				session = session || {};
				session.user = {TODO:"todo"}

				if( !this.checkAuth(session.user, subject) ){
					socket.emit('rpc.resp', {
						rid,
						error: "Access Denied"
					});
					return;
				}

				try {
					if(!subject || subject == 'init-http') {
						socket.emit('rpc.resp', {
							rid,
							error: "Malformed request"
						});
					}else{
						var listeners = this.listeners(subject);
						if(listeners.length == 1) {
							let callback = (error, data) => {
								// console.log("callback",subject,data);
								socket.emit('rpc::response', {
									rid, error, data
								});
							}
							let p = listeners[0](data, callback, { subject, socket, rpc : this });
							if(p && typeof(p.then == 'function')) {
								let data = null;
								try {
									data = await p;
								} catch(ex) { 
									console.log(ex);
									return callback(ex); 
								}
								callback(null, data);
							}
						}else if(listeners.length){
							socket.emit('rpc::response', {
								rid,
								error: `Too many handlers for ${subject}`
							});
						}else{
							socket.emit('rpc::response', {
								rid,
								error : `No such handler ${JSON.stringify(subject)}`
							});
						}
					}
				}
				catch(ex) { console.error(ex.stack); }
			});

			socket.on('message', (msg, callback)=>{
				try {
					let { subject, data } = msg;
					this.emit(subject, data, { subject, socket, rpc : this });
				}
				catch(ex) {
					console.error(ex.stack);
				}
			});
		});
	}

	unsignCookies(obj, secret){
		let {CookieSignature} = FlowHttp.modules;
		if(!CookieSignature)
			throw new Error("CookieSignature module is required.");

        let ret = {};
        Object.keys(obj).forEach(key=>{
            let val = obj[key];
            if (0 == val.indexOf('s:')) {
                val = CookieSignature.unsign(val.slice(2), secret);
                if (val) {
                    ret[key] = val;
                    delete obj[key];
                }
            }
        });
        return ret;
    }

	// !!! ##############################
	// !!! ##############################
	// !!! ##############################


	initExpressApp(){
		let {config} = this;
		let {express} = FlowHttp.modules;
		if(typeof express!= 'function')
			throw new Error("flow-http.FlowHttp requires express module.");
		let app = express();
		this.app = app;
		this.express = express;
		this.initSession(app);
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
		let sessionOptions = {
			secret: this.getHttpSessionSecret(),
			name: this.getHttpSessionCookieName(),
			resave: false,
			saveUninitialized:true,
			cookie: { maxAge: /*30 * 24 **/ 60 * 60 * 1000 } // 1 hour
		}
		this.emit("init::session-options", {options:sessionOptions})
		return sessionOptions
	}

	initSession(app){
		let {session} = FlowHttp.modules;
		let options = this.buildSessionOptions();
		if(options){
			this.sessionSecret = options.secret;
			this.sessionKey = options.name;
			if(!options.store)
				options.store = new session.MemoryStore();
			this.sessionStore = options.store;
			this.expressSession = session(options);
			app.use(this.expressSession);
			//this.log("sessionStore", this.sessionStore)
		}
	}

    getSessionById(sid){
    	return new Promise((resolve, reject)=>{
	        if(!this.sessionStore)
	            return reject({error: "Session not initilized."});

	        this.sessionStore.get(sid, (err, session)=>{
	            if (err)
	                return reject(err);
	            if(!session)
	            	return reject(`${sid}: Session not found`)

	            session.id = sid;

	            resolve(session);
	        });
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

	getHttpSessionCookieName(){
		let {session} = this.config.http || {};
		return (session && session.key)? session.key : 'connect.sid';
	}

	getHttpSessionSecret(secret="xyz"){
		if(this._httpSessionSecret)
			return this._httpSessionSecret;

		this._httpSessionSecret = crypto.createHash('sha256')
			.update(secret+this.config.http.session.secret)
			.digest('hex');
		return this._httpSessionSecret;
	}


	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////
	// !!! /////////////////////////////////////////////////////////////////////////////////////////////////




	____initWebSocketInterface_v2(){
		let core = this.core;
		this.webSocketMap = {};
		let socketsOpen = 0;
	
		this.webSockets = core.io.of(this.config.websocketPath).on('connection', (socket)=>{
			core.getSocketSession(socket, (err, session)=>{
	
				this.webSocketMap[socket.id] = socket;
				socket.session = session;
	
				this.rpc.attach(socket.id, socket);
				socketsOpen++;
	
				this.rpc.disptach(socket.id, 'init', {
					uuid : core.uuid, 
					name : core.pkg.name,
					version : core.pkg.version,
					hostname : os.hostname() 
				})
	
	
				this.emit("socket-connected", {socket});
	
				socket.on('disconnect', ()=>{
					this.rpc.detach(socket.id, socket);
					delete this.webSocketMap[socket.id];
					socketsOpen--;
				});
				
			});
		});
	}
	
	
	
	
	
	
	____initWebSocketInterface_v1(){
		let core = this.core;
		this.webSocketMap = {};
		let socketsOpen = 0;
	
		this.webSockets = core.io.of(this.config.websocketPath).on('connection', (socket)=>{
			core.getSocketSession(socket, (err, session)=>{
	
				this.webSocketMap[socket.id] = socket;
				socket.session = session;
				socketsOpen++;
				socket.emit('message', { 
					subject : 'init', 
					data : { 
						uuid : core.uuid, 
						name : core.pkg.name,
						version : core.pkg.version,
						hostname : os.hostname() 
					} });
				this.emit("socket-connected", {socket});
	
				socket.on('disconnect', ()=>{
					delete this.webSocketMap[socket.id];
					socketsOpen--;
				});
	
				socket.on('rpc::request', async (msg) => {
					let { req : { subject, data }, rid } = msg;
	
					session = session || {};
					session.user = {TODO:"todo"}
	
					if( !this.checkAuth(session.user, subject) ){
						socket.emit('rpc::response', {
							rid,
							error: "Access Denied"
						});
						return;
					}
	
					try {
						if(!subject || subject == 'init-http') {
							socket.emit('rpc::response', {
								rid,
								error: "Malformed request"
							});
						}else{
							var listeners = this.listeners(subject);
							if(listeners.length == 1) {
								let callback = (error, data) => {
									// console.log("callback",subject,data);
									socket.emit('rpc::response', {
										rid, error, data
									});
								}
								let p = listeners[0](data, callback, { subject, socket, rpc : this });
								if(p && typeof(p.then == 'function')) {
									let data = null;
									try {
										data = await p;
									} catch(ex) { 
										console.log(ex);
										return callback(ex); 
									}
									callback(null, data);
								}
							}else if(listeners.length){
								socket.emit('rpc::response', {
									rid,
									error: `Too many handlers for ${subject}`
								});
							}else{
								socket.emit('rpc::response', {
									rid,
									error : `No such handler ${JSON.stringify(subject)}`
								});
							}
						}
					}
					catch(ex) { console.error(ex.stack); }
				});
	
				socket.on('message', (msg, callback)=>{
					try {
						let { subject, data } = msg;
						this.emit(subject, data, { subject, socket, rpc : this });
					}
					catch(ex) {
						console.error(ex.stack);
					}
				});
			});
		});
	}
	
	checkAuth(user, subject) {
		return true;
	}
	
	


}

module.exports = FlowHttp
