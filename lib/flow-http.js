const path 	= require("path");
const fs 	= require("fs");
const http = require('http');
const https = require('https');
const EventEmitter = require("events");
const crypto = require("crypto");
const FlowUid = require("@aspectron/flow-uid");
const { AsyncQueue, AsyncQueueSubscriberMap } = require("@aspectron/flow-async");
const utils = require("./utils");

// socket lifetime open->connect->[available]->disconnect->close
// open - socket open, not initialized
// connect - socket initialized and available for use
// disconnect - socket disconnected, socket state available
// close - socket states cleaned up
class FlowHttp extends EventEmitter{

	static METHODS = Object.freeze({
		PUBLISH : 1,
		REQUEST : 2,
		SUBSCRIBE : 3
	});

	constructor(appFolder, options={}){
		super();
		this.appFolder_ = appFolder;
		this.initLog();
		this.pkg = require(path.join(this.appFolder, "package.json"));
		this.options = Object.assign({}, this.defaultOptions, options);
		this._log = {
			'INFO' : 1,
			'WARN' : 2,
			'DEBUG' : 3
		}
		this.rtUID = FlowUid({ length : 16 });
		this.asyncSubscribers = new AsyncQueueSubscriberMap();
		this.intake = new EventEmitter();
		this.sockets = {
			on : (subject, handler) => { this.intake.on(...args); },
			publish : (subject, data) => {
				this.websocketMap.forEach((socket) => socket.publish(subject,data));
				//this.websocketMap.forEach((socket) => socket.write(JSON.stringify(['message',{subject,data}])));
			},
			subscribe : (subject) => {
				return this.asyncSubscribers.subscribe(subject);
			},
			events : new AsyncQueueSubscriberMap()
		}
		this.debug = true;
	}

	async init(){
		await this._init();
	}
	async _init(){
		this.initConfig();

		if(this.config.certificates && this.config.http.ssl)
			await this.initCertificates();
		await this.initHttp(this);
		await this.initGRPC();
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

	initNATS(nats) {
		const jc = FlowHttp.modules.NATS.JSONCodec();
		if(!this.MSG)
			throw new Error(`must call initAuth() before initNATS()`);

		this.nats = nats;

		let castMsgLen = this.MSG.cast.length+1;

		//nats.subscribe(`*.PCAST.${this.rtUID}.>`, (err, msg) => {
		nats.subscribe(`${this.MSG.cast}.>`, { callback : (err, msg) => {
			let { subject : castMsgSubject, data:res } = msg;
			res = jc.decode(res);
			const {token, data} = res || {};
			if(!token) {
				this.log(`error: received ${this.MSG.cast} msg without token`);
				return;
			}

			// client should subscribe to this.MSG.unbind
			const subject = castMsgSubject.substring(castMsgLen);
			let socket_id_set = this.tokenToSocketMap.get(token);
			if(socket_id_set) {
				socket_id_set.forEach(sid=>{
					console.log("publishing to sid",sid,subject);
					const socket = this.websocketMap.get(sid);
					socket?.emit('publish', { 
						subject,
						data 
					});
				})
			}
		}});

		nats.subscribe(this.MSG.unbind, { callback : (err, msg) => {
			const data = jc.decode(msg.data);
			const token = data?.token;
			if(!token) {
				this.log(`error: received ${this.MSG.unbind} msg without token`);
				return;
			}

			// client should subscribe to this.MSG.unbind
			// post separate "signout" msg?
			// let socket_id_set = this.tokenToSocketMap.get(token);
			// if(socket_id_set) {
			// 	for(const sid of socket_id_set) {
			// 		const socket = this.websocketMap.get(sid);
			// 	}
		}});
	}

	initHttp(){
		return new Promise((resolve, reject)=>{
			let {config} = this;
			let {http:httpConfig} = config;
			if(!httpConfig)
				return

			let {port, host, ssl} = httpConfig;

			this.initExpressApp();
			this.emit("app.init", {app:this.app});
			this.emit("init::app", {app:this.app}); // deprecated
			this.initStaticFiles();

			http.globalAgent.maxSockets = config.maxHttpSockets || 1024;
			https.globalAgent.maxSockets = config.maxHttpSockets || 1024;

			let CERTIFICATES = ssl && this.certificates;
			console.log("CERTIFICATES", ssl, this.certificates, CERTIFICATES)

			let args = [ ]
			args.push(port);
			host && args.push(host);

			args.push(err=>{
				if(err){
					console.error(`Unable to start HTTP(S) server on port ${port}${host?" host '"+host+"'":''}`);
					return reject(err);
				}

				this.log(`HTTP server listening on port ${(port+'').cyan}${host?" host '"+(host+'').cyan+"'":''}`);

				if (!CERTIFICATES)
					this.log(("WARNING - SSL is currently disabled").yellow);

				this.emit('server.init', {server:this.server});
				this.emit('init::http-server', {server:this.server}); // deprecated
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

			if(this.config.websocketPath) {

				const ctx = { websocketMode : this.config.websocketMode };
				this.initSocketServer(ctx);

				const { ws, sockjs } = FlowHttp.modules;
				if(ws) {
					ctx.ws = ws;
					this.io = new ws.Server({ server, path : this.config.websocketPath });
					this.initSocketHandler(ctx, this.config.websocketMode || FlowHttp.MODE.RPC);
				}
				else
				if(sockjs) {
					ctx.sockjs = sockjs;
					// this.sockjs = sockjs;
					this.io = sockjs.listen(this.server, { prefix: this.config.websocketPath });
					this.initSocketHandler(ctx, this.config.websocketMode || FlowHttp.MODE.RPC);
				}
			}

			server.listen.apply(server, args);

		});
	}

	initSocketServer(ctx) {
		this.websocketMap = new Map();
		// TODO - HANDLE FDXS.unbind to detach tokens from sockets
		this.tokenToSocketMap = new Map();
		this.subscriptionMap = new Map();
		this.pendingMap = new Map();
		this.default_nats_request_options = { max : 1 };

		ctx.subscriptionTokenMap = new Map();
		this.socketsOpen = 0;
	}

	initSocketHandler(ctx, websocketMode) {
		//this.sockjs = sockjs;
		this.MAX_SUBSCRIPTIONS = 512;

		this.websockets = this.io.on('connection', async (conn_impl, req)=>{

			if(!conn_impl) {
				console.trace('invalid sockjs connection (null socket) - aborting');
				// console.log(arguments);
				return;
			}
			if(!conn_impl.id)
				conn_impl.id = FlowUid({ length : 24 });
			//console.log("conn_impl, req", conn_impl, req)

			let headers = null;
			let remoteAddress = null;
			let send_ = null;
			let msgevent = null;
			if(ctx.ws) {
				headers = req.headers;
				remoteAddress = req.remoteAddress;
				send_ = conn_impl.send;
				msgevent = 'message';
			}
			else
			if(ctx.sockjs) {
				headers = conn_impl.headers;
				remoteAddress = conn_impl.remoteAddress;
				send_ = conn_impl.write;
				msgevent = 'data';
			}

			let socket_is_alive = true;
			const ip = this.getIpFromHeaders(headers) || conn_impl.remoteAddress;
			//console.log(socket);
			const socket = {
				conn_impl,
				id : conn_impl.id,
				ip,
				headers,
				emit(...args) {
					if(socket_is_alive)
						send_.call(conn_impl, JSON.stringify(args));
				},
				publish(subject, data) {
					if(socket_is_alive)
						send_.call(conn_impl,JSON.stringify(['publish',{ subject, data }]));
				},
				on(...args) { conn_impl.on(...args); },
				session : {
					user : { token : null }
				},
				//subscriptions : 0
			}



			if(ctx.ws) {
				socket.req = req;
			}else if(ctx.sockjs) {
				socket.req = conn_impl;
			}

			socket.on(msgevent, (data)=>{
				let [ event, msg ] = JSON.parse(data);
				//console.log("SOCKET DATA:",event,msg);
				this.socketMessageHandler(socket, event, msg, ctx);
			})

			socket.emit('auth.getcookie');

			this.socketsOpen++;
			let rids = 0, oldSocket;
			if(oldSocket = this.websocketMap.get(socket.id)){
				console.log("#########\n########\n######### oldSocket oldSocket", conn_impl.id, socket.id, oldSocket)
				socket._sIds = oldSocket._sIds;
			}
			this.websocketMap.set(socket.id, socket);
			if(!this.subscriptionMap.has(socket.id))
				this.subscriptionMap.set(socket.id, []);
			const subscriptions = this.subscriptionMap.get(socket.id);

			if(!this.pendingMap.has(socket.id))
				this.pendingMap.set(socket.id, new Map())
			const pending = this.pendingMap.get(socket.id);

			socket.on('close', () => {
				socket_is_alive = false;

				const msg = { socket, ip };//, socket.session };
				this.emit('socket.disconnect', msg);
				this.sockets.events.post('disconnect', msg);

				if(socket.session.user.token) {
					let socket_id_set = this.tokenToSocketMap.get(socket.session.user.token);
					if(socket_id_set) {
						socket_id_set.delete(socket.id);
						if(!socket_id_set.size)
							this.tokenToSocketMap.delete(socket.session.user.token);
					}
				}
				this.websocketMap.delete(socket.id);
				while(subscriptions.length) {
					const { token, subscription } = subscriptions.shift();
					ctx.subscriptionTokenMap.delete(token);
					subscription.unsubscribe();
					//this.nats.unsubscribe();
				}
				this.subscriptionMap.delete(socket.id);

				pending.forEach(cb=>{
					cb('disconnect');
				});

				pending.clear();

				this.emit('socket.close', msg);
				this.sockets.events.post('close', msg);

				this.socketsOpen--;
			});

			socket.emit('message', { subject : 'init' });
			this.emit("websocket.open", {socket});
			this.emit("socket.open", {socket});

		});
	}
	handleGRPC(socket, eventName, msg, ctx){
		if(eventName.indexOf("grpc.")!==0)
			return false;

		const socketId = socket.id;

		if(eventName == 'grpc.proto.get'){
			//console.log("grpc.proto.get", this.grpcProto)
			socket.emit('message', {subject:'grpc.proto', data:{proto:this.grpcProto}});
			return;
		}

		if(eventName == 'grpc.stream.write'){
			let { req : { client:clientName, method, data }, sId, rid } = msg;
			this.debug && console.log('got grpc.stream.write:', method, '->', msg);
			const client = this.grpcClients[clientName];
			if(!client)
				return socket.emit('grpc.stream.response', { rid, sId, error: `No such service client "${clientName}".` });

			//this.debug && console.log('allowing request:', method, '->', data);
			//console.log(`typeof this.grpc.${clientName}.${method}`, typeof client[method])

			if(typeof client[method] != "function"){
				socket.emit('grpc.stream.response', { rid, sId, error: `${method} function not found` });
				return
			}


			this.writeGRPCStream({
				client, method,
				sId, data, socketId
			}, (error, response)=>{
				console.log("grpc.stream.response", data, error, response)
				if(error){
					socket.emit('grpc.stream.response', {rid, sId, error});
					return
				}

				socket.emit('grpc.stream.response', {rid, sId, response});
			});
			return true;
		}

		if(eventName == 'grpc.stream.end'){
			let { client:clientName, method, sId, rid } = msg;
			this.debug && console.log('got grpc.stream.write:', method, '->', msg);
			const client = this.grpcClients[clientName];
			if(!client)
				return;//socket.emit('grpc.stream.response', { rid, sId, error: `No such service client "${clientName}".` });

			if(typeof client[method] != "function"){
				//socket.emit('grpc.stream.response', { rid, sId, error: `${method} function not found` });
				return;
			}

			this.endGRPCStream({client, method, sId, socketId})

			return;
		}

		if(eventName == 'grpc.request'){

			let { req : { client:clientName, method, data }, rid } = msg;
			this.debug && console.log('got grpc.request:', method, '->', msg);

			if(this.messageFilter_ && !this.messageFilter_(method)) {
				socket.emit('grpc.response', { rid, error: "Unknown Message" });
				return;
			}
			if(!data)
				data = { };
			if(!this.checkAuth(session.user, method, data, FlowGRPCProxy.METHODS.REQUEST)) {
				socket.emit('grpc.response', { rid, error: "Access Denied" });
				return;
			}
			const client = this.grpcClients[clientName];
			if(!client){
				socket.emit('grpc.response', { rid, error: `No such service client "${clientName}".` });
				return
			}

			this.debug && console.log('allowing request:', method, '->', data);
			//console.log(`typeof this.grpc.${clientName}.${method}`, typeof client[method])

			if(typeof client[method] != "function"){
				socket.emit('grpc.response', { rid, error: `${method} function not found` });
				return
			}
			client[method](data, (error, response) => {

				this.debug && console.log("+++++++++++++++++++++++++++++++++++++++++");
				this.debug && console.log('got response:', method, '->', error, response);
				if(!error)
					this.handleResponse(socket.id, session.user, method, response, session);

				socket.emit('grpc.response', {rid, error, response});
			})
			return;
		}

		return false;
	}

	async initGRPC() {
		if(!this.config.grpc)
			return
		const {json, proto, grpc, server} = this.parseProto(this.config.grpc||{});

		this.grpcClients = {};
		utils.each(json.services, (value, name)=>{
			this.grpcClients[name] = new proto[name](server,
						grpc.credentials.createInsecure());
			this.grpcClients[name].__name = name;
		});
		this.grpcProto = json;

		/*
		try{
			this.testRPC(this.grpcClients.RPC);
		}catch(e){
			console.log("testRPC:error:", e)
		}
		*/
	}
	testRPC(client){
		//var client = new RPC('localhost:16210', gRPC.credentials.createInsecure());
		//console.log("client", client)
		//let reqStream = {getBlockDagInfoRequest:{}};
		let stream = client.MessageStream((...args)=>{
			console.log("MessageStream fn", args)
		});

		//console.log("stream", stream);

		stream.on('metadata', function(...args) {
			console.log('stream metadata', args);
		});
		stream.on('status', function(...args) {
			console.log('stream status', args);
		});
		stream.on('data', function(...args) {
			console.log('stream data', args);
			stream.end();
		});
		stream.on('end', (a, b)=>{
			console.log('stream end', a, b);
		});
		stream.on('finish', (a, b)=>{
			console.log('stream finish', a, b);
		});
		let req = {
			//getUTXOsByAddressRequest:{}
			getBlockDagInfoRequest:{}
		}
		stream.write(req);
	}

	parseProto(config){
		const { grpc, protoLoader} = FlowHttp.modules;
		if(!grpc || !protoLoader)
			throw new Error("FlowHttp requires grpc and protoLoader modules.");

		const {protoPath, server, packageKey, loaderConfig={}} = config;
		const params = Object.assign({
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true
		}, loaderConfig);

		const packageDefinition = protoLoader.loadSync(protoPath, params);
		const proto = grpc.loadPackageDefinition(packageDefinition)[packageKey];
		//const client = new proto.RPC(server,
						//grpc.credentials.createInsecure());
		const json = {services:{}, msg:{}};
		utils.each(proto, (value, key)=>{
			if(value.service){
				json.services[key] = JSON.parse(JSON.stringify(value.service));
				utils.each(json.services[key], (value, method)=>{
					delete value.requestType.fileDescriptorProtos;
					delete value.responseType.fileDescriptorProtos;
					//console.log("key:method:value", method, value)
				})
			}else{
				value = JSON.parse(JSON.stringify(value));
				json.msg[key] = value;
				delete value.fileDescriptorProtos;
			}
			//value = JSON.parse(JSON.stringify(value))
			//console.log("proto, key:value", key, JSON.stringify(value.service, null, "\t"))
		})
		//console.log("json", JSON.stringify(json, null, "  "))
		return {json, proto, grpc, server}
	}

	endGRPCStream({client, method, sId, socketId, data}, callback){
		return
		const next = (socket)=>{
			socket?.emit("message", {subject:"grpc.stream.end", data:{sIds:[sId]}})
			callback && callback(null, {success:true})
		}

		const stream = client?._streams?.[method];

		let socket = this.websocketMap.get(socketId);
		if(!socket)
			return next()

		socket._sIds?.delete(method+sId)
		let size = socket._sIds?.size||0;
		console.log("endGRPCStream", size, sId, [...socket._sIds?.values()])
		if(!size && stream){
			stream._socketIds.delete(socketId);
			console.log("endGRPCStream:socketIds", [...stream._socketIds?.values()])
			if(!stream._socketIds.size){
				stream.end();
				console.log("calling stream.end ...")
			}
		}
		next(socket)
	}

	writeGRPCStream({client, method, sId, socketId, data}, callback){
		if(!client._streams)
			client._streams = {};
		if(!client._streams[method]){
			const stream = client[method]();
			client._streams[method] = stream
			stream._callbacks = [];
			stream._socketIds = new Set();
			stream.on('data', (data)=>{
				//stream.end();
				let cb = stream._callbacks.shift();
				//console.log('stream data', data, cb);
				if(cb){
					cb(null, data);
				}else{
					stream._socketIds.forEach(socketId=>{
						let socket = this.websocketMap.get(socketId)
						if(socket){
							let sIds = [...socket._sIds.values()].map(a=>a.sId);
							socket.emit("message", {
								subject:"grpc.stream.data",
								data:{data, sIds}
							})
						}
					})
				}
			});
			stream.on('end', ()=>{
				console.log('stream end');
				stream._socketIds.forEach(socketId=>{
					let socket = this.websocketMap.get(socketId)
					if(socket){
						let sIds = [...socket._sIds.values()].map(a=>a.sId);
						socket.emit("message", {subject:"grpc.stream.end", data:{sIds}})
					}
				})
				client._streams[method] = null;
			});

			
			stream.on('error', (error)=>{
				console.log('stream error', error);
				/*
				stream._socketIds.forEach(socketId=>{
					let socket = this.websocketMap.get(socketId)
					if(socket){
						let sIds = [...socket._sIds.values()];
						socket.emit("message", {subject:"grpc.stream.error", data:{sIds, error}})
					}
				})
				*/
			});
		}

		let socket = this.websocketMap.get(socketId);
		if(!socket._sIds)
			socket._sIds = new Map();
		socket._sIds.set(method+sId, {method, sId});

		const stream = client._streams[method];
		stream._socketIds.add(socketId);
		stream._callbacks.push(callback);
		stream.write(data);
	}

	socketMessageHandler(socket, event, msg, ctx) {
		const {ip} = socket;

		const jc = FlowHttp.modules.NATS?.JSONCodec?.();
		let result = this.handleGRPC(socket, event, msg, ctx);
		if(result!==false)
			return

		//console.log("+++++++++++++++++++++ EVENT",event,msg);
		if(event == 'auth.cookie') {
			// console.log("----------- auth:cookie");
			let cookie = msg.cookie;
			let req = {
				url: socket.req.url,
				pathname: socket.req.pathname,
				protocol: socket.req.protocol,
				connection: socket.req.connection,
				headers: socket.req.headers
			};
			let res = { };
			res.writeHead = () => ({ });
			res.end = () => ({ });
			res.getHeader = () => { return false };
			res.setHeader = (name, value) => {
				if (name === 'Set-Cookie') {
					socket.emit('auth.setcookie', { cookie: value });
				}
			}
			if (cookie !== null) {
				req.headers.cookie = cookie;
			}
			this.expressSession(req, res, ()=> {
				res.writeHead();
				res.end();
				//session = req.session;
				socket.session = req.session;
				if(!socket.session.user)
				socket.session.user = { token : null }
				//console.log("#### socket:init".redBG, socket.id, session)

				if(socket.session.user.token)
					this.addSocketIdToTokenSocketMap(socket.session.user.token, socket.id);

				socket.emit('ready', {websocketMode:ctx.websocketMode});
				const msg = { socket };//, session };
				this.emit('websocket.connect', msg);
				//this.emit('socket.connect', msg);
				//console.log("############# emit connect######################")
				this.sockets.events.post('connect', msg);
			});
			return;
		}
		if(ctx.websocketMode == 'RPC') {
			switch (event) {

				case 'publish': {
					try {
						let { subject, data } = msg;
						this.asyncSubscribers.post(subject, { data, socket });
					}
					catch(ex) {
						console.error(ex.stack);
					}
					break;
				}

				case 'request': {
					let { req : { subject, data }, rid } = msg;

					if(!data)
						data = { };

					if( !this.checkAuth(socket.session.user, subject, data, FlowHttp.METHODS.REQUEST) ){
						socket.emit('response', { rid, error: "Access Denied" });
						return;
					}

					try {
						if(!subject || subject == 'init-http') {
							socket.emit('response', { rid, error: "Malformed request" });
						} else {

							let subscribers = this.asyncSubscribers.map.get(subject);
							if(subscribers.length == 1) {
								subscribers[0].post({
									data,
									socket,
									ip,
									respond : (resp) => {
										const msg = { rid };
										if(resp instanceof Error)
											msg.error = resp.toString();
										else
											msg.data = resp;
											socket.emit('response', msg);
									},
									error : (error) => {
										socket.emit('response', {
											rid, error
										});
									}
								});

							} else if(subscribers.length){
								socket.emit('response', {
									rid,
									error: `Too many subscribers for ${subject}`
								});
							} else {
								socket.emit('response', {
									rid,
									error : `No such handler ${JSON.stringify(subject)}`
								});
							}
						}
					}
					catch(ex) { console.error(ex.stack); }
					break;
				}
				default: {
					console.log("unhandled:", event);
				}
			}
		}
		else if(ctx.websocketMode == 'NATS')
		{
			switch (event) {
				case 'response': {
					let { resp, rid } = msg;
					if(pending.has(rid)) {
						let cb = pending.get(rid);
						pending.delete(rid);
						cb(null, resp);
					}
					break;
				}
				case 'publish': {
					// TODO - check token, reject or publish to NATS
					let { req : { subject, data }, ack, rid } = msg;

					if(!data)
						data = { };
					if(!this.checkAuth(socket.session.user, subject, data, FlowHttp.METHODS.PUBLISH)) {
						socket.emit('publish::response', { rid, error: "Access Denied" });
						return;
					}

					if(!ack)
						return this.nats.publish(subject, jc.encode(data));

					this.nats.publish(subject, jc.encode(data));
					socket.emit('publish::response', { rid, ack : true });
					break;
				}
				case 'unsubscribe': {
					// TODO - sanity checks
					if(!msg || !msg.req) {
						socket.emit('unsubscribe::response', { rid, error : 'malformed request' });
						return;
					}


					let { req : { token }, rid } = msg;

					let sub = ctx.subscriptionTokenMap.get(token);
					if(!sub) {
						socket.emit('unsubscribe::response', { rid, error : 'no such token' });
						return;
					}

					const { subscription } = sub;
					ctx.subscriptionTokenMap.delete(token);
					subscription.unsubscribe();
					socket.emit('unsubscribe::response', { rid, ok : true });
					break;
				}
				// NATS subscribe
				case 'subscribe': {
					// TODO - sanity checks
					// console.log('subscribe msg',msg);
					if(!msg || !msg.req || !msg.req.subject) {
						socket.emit('subscribe::response', { rid, error : 'malformed request' });
						return;
					}

					let { req : { subject, opt }, rid } = msg;
					const d_ = { };
					if(!this.checkAuth(socket.session.user, subject, d_, FlowHttp.METHODS.SUBSCRIBE)) {
						socket.emit('subscribe::response', { rid, error: "Access Denied" });
						return;
					}

					const subscriptions = this.subscriptionMap.get(socket.id);
					if(subscriptions.length > this.MAX_SUBSCRIPTIONS) {
						socket.emit('subscribe::response', { rid, error: "Maximum Number of Subscriptions Reached" });
						return;
					}

					//this.nats.publish(subject,message);

					console.log('subscribing subject:',subject);
					const subscription = this.nats.subscribe(subject, (msg, err) => {
					//this.nats.subscribe(subject, (msg, reply, subject, sid) => {
						// console.log('flow-http NATS subscribe subject:',subject);
						// const { reply, data, subject } = msg;

						const data = jc.decode(msg.data);

						if(msg.reply) {
							const subject = msg.subject;

							const rid = rids++;
							socket.emit('request', { rid, req : { subject, data }});
							pending.set(rid, (error, data) => {
								if(error)
									msg.respond(jc.encode({ error }));
								else
									msg.respond(jc.encode(data));
							})
							// const pending = this.pendingMap[socket.id]
							// this.pendingMap[socket.id]
							// this is a request to us...
							//this.nats.publish(reply, data)
						}

						socket.emit('publish', { subject, data });
					})

					// subscriptions
					let token = FlowUid({ length : 24 });
					subscriptions.push({ token, subscription });
					ctx.subscriptionTokenMap.set(token, subscription);

					socket.emit('subscribe::response', { rid, token, subject });

					break;
				}
				// NATS request
				case 'request': {

					let { req : { subject, data, opt }, rid } = msg;
					this.debug && console.log('got request:', subject, '->', msg);

					if(this.messageFilter_ && !this.messageFilter_(subject)) {
						socket.emit('response', { rid, error: "Unknown Message" });
						return;
					}

					// data needs to always be present to carry user
					// token installed by checkAuth()
					if(!data)
						data = { };
					if(!this.checkAuth(socket.session.user, subject, data, FlowHttp.METHODS.REQUEST)) {
						socket.emit('response', { rid, error: "Access Denied" });
						return;
					}

					this.debug && console.log('allowing request:', subject, '->', data);

					if(!opt)
						opt = this.default_nats_request_options;

					// TODO - check token, reject or publish to NATS
					// const { subject, message, opt } = args;
					this.nats.request(subject, jc.encode(data)).then((msg) => {
						const data = jc.decode(msg.data);
						const code  = "";//????
						const error = "";//????
						this.debug && console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
						this.debug && console.log('got response:', subject, '->', error, code, data);

						this.handleResponse(socket.id, socket.session.user, subject, data, socket.session);

						socket.emit('response', { rid, data })
					}).catch((error) => {
						console.log(`NATS error during subject '${subject}'`, error);
						socket.emit('response', { rid, error });

						// if(error.code == 'TIMEOUT') {
						// 	console.log(`NATS RPC request timed out - subject: ${subject}`);
						// 	console.log(error.stack);
						// 	socket.emit('response', { rid, error: `NATS timeout code: ${msg.code} subject: ${subject}` });
						// }
					});
					break;
				}

				default: {
					console.log("unhandled:", event);
				}
			}
		}
	}

	initAccess(prefix, publicFilter, privateFilter) {
		this.MSG = Object.freeze({
			auth : `${prefix}.auth`,
			signup: `${prefix}.signup`,
			authClose : `${prefix}.auth.close`,
			bind : `${prefix}.bind`,
			unbind : `${prefix}.unbind`,
			cast : `${prefix}.cast.${this.rtUID}`,
		});
		this.publicFilter_ = publicFilter;
		this.privateFilter_ = privateFilter;
	}

	messageFilter(filter) {
		this.messageFilter_ = filter;
	}
	preflight(preflight) {
		this.preflight_ = preflight;
	}

	checkAuth(user, subject, data, method) {
		if(!this.MSG)
			return true;
		if(this.preflight_ && this.preflight_(user, subject, data, method)===false)
			return false;
		if(subject == this.MSG.auth || subject == this.MSG.signup) {
			data.peer = this.rtUID;
			return true;
		}

		if(this.publicFilter_ && this.publicFilter_(subject, method))
			return true;
		if(!user.token)
			return false;

		if(subject == this.MSG.authClose || this.privateFilter_ && this.privateFilter_(subject, method)) {
			if(data) {
				data.token = user.token;
				// data.peer = this.rtUID;
			}
			return true;
		}

		return false;
	}

	handleResponse(socket_id, user, subject, response, session) {
		if(subject == this.MSG.authClose){
			if(user)
				user.token = null;
			return this.updateSessionRecord(session);
		}
		if(subject == this.MSG.auth) {
			const token = response.token;
			delete response.token;

			user.token = token;
			if(token) {
				this.addSocketIdToTokenSocketMap(token, socket_id);
			}

			this.updateSessionRecord(session);
		}
	}

	updateSessionRecord(session){
		if(this.sessionStore){
			//console.log("this.sessionStore", this.sessionStore)
			this.sessionStore.set(session.id, session, (err)=>{
				if(err)
					console.log("sessionStore.set: error", session, err)
			});
		}
	}

	addSocketIdToTokenSocketMap(token, socketId){
		let socket_id_set = this.tokenToSocketMap.get(token);
		if(!socket_id_set) {
			socket_id_set = new Set();
			this.tokenToSocketMap.set(token, socket_id_set);
		}
		socket_id_set.add(socketId);
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
		let {xFrameOptions="SAMEORIGIN"} = config.http||{};
		if(xFrameOptions){
			app.use((req, res, next)=>{
				if(req.url == "/" || req.url == "/index.html")
					res.setHeader("X-Frame-Options", xFrameOptions);
				next();
			})
		}
		this.express = express;
		this.initSession(app);
	}

	initStaticFiles(){
		if(!this.config.staticFiles)
			return
		let ServeStatic = this.express.static;
		utils.each(this.config.staticFiles, (dst, src)=>{
			console.log('HTTP serving '+src.cyan+' -> '+dst.cyan);
			this.app.use(src, ServeStatic(path.join(this.appFolder, dst)));
		})
	}

	initCertificates(){
		if(this.verbose)
			console.log('iris-app: loading certificates from ', this.appFolder+'/'+this.config.certificates);
		if(this.certificates) {
			console.error("Warning! initCertificates() is called twice!".red);
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
		let file = path.join(this.appFolder, filename);
		let parts = file.split('.');
		parts.splice(parts.length-1, 0, '.local');
		let local = parts.join();
		if(fs.existsSync(local))
			return local;
		if(!ignore && !fs.existsSync(file)) {
			this.log("Unable to locate certificate file:".red, file);
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
		this.emit("init::session-options", {options:sessionOptions});
		this.emit("session.options", {options:sessionOptions});
		return sessionOptions
	}

	initSession(app){
		let {session} = FlowHttp.modules;
		let options = this.buildSessionOptions();
		if(options && session){
			this.sessionSecret = options.secret;
			this.sessionKey = options.name;
			if(!options.store)
				options.store = new session.MemoryStore();
			this.sessionStore = options.store;
			options.cookie.httpOnly = false;
			this.expressSession = session(options);
			app.use(this.expressSession);
			//this.log("sessionStore", this.sessionStore)
		}
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
		return this.appFolder_;//process.cwd();
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

	getIpFromHeaders(headers) {
		return headers['cf-connecting-ip'] || headers['x-real-ip'] || headers['x-client-ip'];
	}

	async shutdown() {
		this.asyncSubscribers.shutdown();
		this.sockets.events.shutdown();
	}

}

module.exports = FlowHttp
