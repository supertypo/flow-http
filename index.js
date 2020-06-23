const HttpApp = require("./lib/http-app");

module.exports = (modules)=>{
	let {express} = modules||{};
	if(typeof express!= 'function')
		throw new Error("flow-http.HttpApp requires express module.");
	HttpApp.modules = modules;
	return {HttpApp}
}