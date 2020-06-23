const path 	= require("path");
const fs 	= require("fs");
const http = require('http');
const https = require('https');
const EventEmitter = require("events");
const crypto = require("crypto");
const ejs = require("ejs");
const CookieSignature = require('cookie-signature');
const Cookie = require('cookie');

const utils = require("./utils");

class HttpApp extends EventEmitter{
	constructor(options={}){
		super();
		this.initLog();
		this.pkg = require(path.join(this.appFolder, "package.json"));
		this.options = Object.assign({}, this.defaultOptions, options);
		this._stepsBeforeHttp = [];
		this._stepsBeforeInit = [];
		this._initSteps = [];
		this._log = {
	        'INFO' : 1,
	        'WARN' : 2,
	        'DEBUG' : 3
	    }
		
		this.buildSteps();
		//this.init();
	}

	onBeforeInit(fn){
		this._stepsBeforeInit.push(fn);
	}
	onBeforeHttp(fn){
		this._stepsBeforeHttp.push(fn);
	}
	onInit(fn){
		this._initSteps.push(fn);
	}

	buildSteps(){
		//override to add onBeforeInit, onBeforeHttp, onInit steps
		/*
		this.onBeforeHttp((callback)=>{
			//callback({error:"TODO"}) //#option 1
			return new Promise((resolve, reject)=>{ //#option 2
				setTimeout(()=>{
					reject({error:"TODO"})
				}, 2000)
			})
		})
		*/
	}

	async init(){
		await this._init();
	}
	_init(){
		this.initUID();
		this.initConfig();

		let steps = [];
		steps.push(...this._stepsBeforeInit);

		let {config} = this;
		config.certificates && steps.push(this.initCertificates);
		steps.push(...this._stepsBeforeHttp);
		steps.push(this.initHttp.bind(this));
		if(config.http.redirectToSSL)
			steps.push(this.initRedirectToSSL.bind(this));
		config.mailer && steps.push(this.initMailer.bind(this));
		steps.push(...this._initSteps);

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

	initUID(){
		this.uid = "xxxxxxxx";
	}

	initConfig(){
		this.config = {}
		let {configFile} = this.options;
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
			this.initSession(this.app);
			this.initExpressHandlers();

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
			this.config.websocket && this.initWS();
			
		})
	}

	initExpressApp(){
		let {config} = this;
		let {express} = HttpApp.modules;
		if(typeof express!= 'function')
			throw new Error("flow-http.HttpApp requires express module.");
		let app = express();
		this.app = app;
		this.express = express;

		app.locals.getBaseUrl = this.getBaseUrl;
		let sessionSecret = this.getHttpSessionSecret();

		app.set('views', path.join(this.appFolder, 'views'));
		app.set('view engine', config.http.engine || 'ejs');
		if(config.http.engine == 'ejs')
			app.engine('html', require('ejs').renderFile);
		if(config.http.engine == 'ect') {
			let ECT = require('ect');
			this.ectRenderer = ECT({
				watch:true,
				root:path.join(this.appFolder, 'views'),
				ect:'.ect'
			});
			app.engine('ect', this.ectRenderer.render);
		}
		//app.use(require('body-parser')());//express.json());
		app.use(require('body-parser').urlencoded({ extended: true }));
		app.use(require('body-parser').json());
		//app.use(require('method-override')());
		app.use(require('cookie-parser')(sessionSecret));
		//app.use(flash({unsafe: false}));
	}
	initRedirectToSSL() {
		return new Promise((resolve, reject)=>{
	        let port = 80;
	        let app = express();
	        app.get('*', (req, res)=>{
	            res.redirect("https://" + req.headers.host + req.url);
	        })
	        http.createServer(app).listen(port, (err)=>{
	            if (err) {
	                console.error(("Unable to start HTTP redirector on port" + port).magenta.bold);
	                return reject(err);
	            }
	            this.log("HTTP redirector listening on port " + (port+'').bold);
	            resolve();
	        });
	    })
    }

	initWS(){
		let {server} = this;
		let {socketio} = HttpApp.modules;
		if(!socketio)
			throw new Error("socketio module not provided")
		server.on("upgrade", (req, socket, head)=>{
            this.io.engine.ws.once("headers", headers=>{
                let sessionCookie = this.buildHttpSesssionCookie(req, headers);
                if(sessionCookie)
                    headers[headers.length] = "Set-Cookie: "+sessionCookie;
            })
        })
        this.io = socketio.listen(server, {
            'log level': 0, 'secure': !!this._isSecureServer,
            allowRequest:(req, fn)=>{
                if(this.config.handleWSSession){
                    this.allowWSRequest(req, fn)
                }else{
                    fn(null, true);
                }
            }
        });
        this.initWebsocket();
	}

	initWebsocket(){
        this.webSocketMap = new Map();
        this.webSockets = this.io.of(this.config.websocket.path).on('connection', socket=>{
            this.verbose > this._log.DEBUG && console.log(`websocket ${socket.id} connected`);
            this.emit('websocket::connect', socket);
            this.webSocketMap.set(socket.id, socket);
            socket.on('disconnect', ()=>{
                this.emit('websocket::disconnect', socket);
                this.webSocketMap.delete(socket.id);
                this.verbose > this._log.DEBUG && console.log(`websocket ${socket.id} disconnected`);
            })

            if(this.options.disableNativeWebsocketRPC)
            	return
            socket.on('rpc::request', (msg) => {
                this.verbose && console.log('rpc::request',msg);
                try {
                    let { req : { subject, data }, rid } = msg;

                    let listeners = this.listeners(subject);
                    if(listeners.length == 1) {
                        let callback = (error, data) => {
                            socket.emit('rpc::response', {
                                rid, error, data
                            });
                        }

                        listeners[0](data, callback, { subject, socket, rpc : this });
                    }else if(listeners.length){
                        socket.emit('rpc::response', {
                            rid,
                            error : `Too many handlers for ${subject}`
                        });
                    }else{
                        socket.emit('rpc::response', {
                            rid,
                            error : `No handler for ${subject}` 
                        });
                    }
                }
                catch(ex) {
                	console.error(ex.stack);
                }
            });

            socket.on('message', (msg) => {
                this.verbose && console.log('RPC-message:',msg);
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

    buildHttpSesssionCookie(req){
        if(!req.session || !req.sessionID)
            return false;

        let cookieName  = this.getHttpSessionCookieName();
        let signed      = 's:'+CookieSignature.sign(req.sessionID, this.getHttpSessionSecret());
        return Cookie.serialize(cookieName, signed, req.session.cookie);
    }

	getHttpSessionCookieName(){
		let {session} = this.config.http || {};
		return (session && session.key)? session.key : 'connect.sid';
	}

	getHttpSessionSecret(){
		if(this._httpSessionSecret)
			return this._httpSessionSecret;

		this._httpSessionSecret = crypto.createHash('sha256')
			.update(this.uid+this.config.http.session.secret)
			.digest('hex');
		return this._httpSessionSecret;
	}

	initExpressHandlers(){
		let ErrorHandler;
		if(this.config.development)
			ErrorHandler = require('errorhandler')();

		let isErrorView = fs.existsSync(path.join(this.appFolder,'views','error.ejs'));
		this.handleHttpError = (err, req, res, next)=>{
			if(req.xhr) {
				res.json({
					errors: utils.isArray(err.errors)?err.errors:[err.errors]
				});
				return;
			}

			if(isErrorView) {
				res.render('error', {error: err.error||err});
				return;
			}

			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end("Server Error");
		}


		//if(config.translator)
		//	app.use(this.translator.useSession);


		/**
		 * response = {
		 *  status: {Number}
		 *  errors: {String | Array}
		 * }
		 */
		this.app.use((req, res, next)=>{
			res.sendHttpError = (err)=>{
				this.handleHttpError(err, req, res, next);
			}

			next();
		});

		//if(this.router)
		//    this.router.init(this.app);

		this.emit('init::express', this.app);
		this.initApp(this.app)

		if(this.config.http.static) {
			let ServeStatic = this.express.static;
			utils.each(this.config.http.static, (dst, src)=>{
				console.log('HTTP serving '+src.cyan.bold+' -> '+dst.cyan.bold);
				this.app.use(src, ServeStatic(path.join(this.appFolder, dst)));
			})
		}

		this.emit('init::express::error-handlers', this.app);

		/**
		*  Handles errors were sent via next() method
		*
		* following formats are supported:
		*  next(new Error('Something blew up'));
		*  next(400);
		*  next({status: 400, errors: 'Activation code is wrong'});
		*  next({status: 400, errors: ['Activation code is wrong']});
		*
		*/
		this.app.use((err, req, res, next)=>{
			if (typeof err == 'number') {
				err = {
					status: err,
					errors: http.STATUS_CODES[err] || "Error"
				};
			}else if (typeof err == 'string') {
				console.error(err);
				err = {
					status: 500,
					errors: 'Internal Server Error'
				};
			}else if (err instanceof Error) {
				if (this.config.development) {
					err.status = 500;
					return ErrorHandler(err, req, res, next);
				}else{
					console.error(err.stack);
					err = {
						status: 500,
						errors: 'Internal Server Error'
					};
				}
			}

			res.sendHttpError(err);
		});

		this.emit('init::express::done', this.app);
	}

	getBaseUrl(req, locale){
		let loc = '';
		if (locale === true) {
			loc = '/'+req._T.locale;
		}else if (locale) {
			loc = '/'+locale;
		};
		return req.protocol + '://' + req.get('host')+loc+'/';
	}

	async initMailer(){
		let pickupFolder = path.join(this.appFolder, "mailer");
		let {nodeMailer, nodeMailerPickupTransport} = HttpApp.modules;
		if(!nodeMailer)
			throw new Error("nodeMailer module not provided");

		if(this.config.mailer.pickup) {
			if(!nodeMailerPickupTransport)
				throw new Error("nodeMailerPickupTransport module not provided");
			this.mailer = nodeMailer.createTransport(nodeMailerPickupTransport({
				directory: pickupFolder
			}))
		}else{
			this.mailer = nodeMailer.createTransport(this.config.mailer);
		}
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
			app.use(HttpApp.modules.session(options));
			this.log("session.store", options.store.get)
			app.sessionStore = options.store;
		}
	}

	getSocketSession(socket, callback) {
		return new Promise((resolve, reject)=>{
	        let cookies = null;
	        try {
	            cookies = utils.unsignCookies(
	            	Cookie.parse(socket.handshake.headers.cookie || ''),
	            	this.getHttpSessionSecret()
	            );
	        } catch(ex) {
	            console.log(ex.stack);
	            return reject(ex)
	        }


	        let cookieName = this.getHttpSessionCookieName();
	        let sid = cookies[ cookieName ];

	        if(this.app.sessionStore)
	            this.getSessionById(sid).then(resolve, reject);
	        else
	            resolve({cookies})
	    })
    }
    getSessionById(sid){
    	return new Promise((resolve, reject)=>{
	        if(!this.app.sessionStore)
	            return reject({error: "Session not initilized."});

	        this.app.sessionStore.get(sid, (err, session)=>{
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
			configFile:pkg.configFile||path.join(this.appFolder, `config/${ident}.conf`)
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

module.exports = HttpApp
