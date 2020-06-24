const os = require('os');
const fs = require('fs');
const path = require('path');
const CookieSignature = require('cookie-signature');

const utils = module.exports = {
    get platform() {
        let platform = os.platform();
        platform = ({ 'win32' : 'windows' }[platform]) || platform;
        let arch = os.arch();
        return `${platform}-${arch}`;
    }
}

const toString = o=>Object.prototype.toString.call(o);
utils.toString = toString;

utils.isString = o=>toString(o)=='[object String]';
utils.isObject = o=>toString(o)=='[object Object]';
if(Array.isArray)
    utils.isArray = o=>Array.isArray(o);
else
    utils.isArray = o=>toString(o)=='[object Array]';

utils.BufferSuffixFromJSON = (buffer, suffix) => {
    suffix = JSON.stringify(suffix);
    let suffixLen = Buffer.alloc(4);
    suffixLen.writeInt32LE(suffix.length, 0);
    return Buffer.concat([buffer,Buffer.from(suffix), suffixLen]);
}

utils.BufferSuffixToJSON = (buffer) => {
    let suffixLen = buffer.readInt32LE(buffer.length-4);
    let suffix = buffer.toString('utf8',buffer.length-4-suffixLen,buffer.length-4);
    return {
        suffix : JSON.parse(suffix),
        length : buffer.length - (suffixLen + 4)
    };
}

utils.sleep = (msec) => {
    return new Promise((resolve) => {
        dpc(msec, resolve);
    })
}

utils.each = (obj, iteratee)=>{

    if(utils.isObject(obj)){
        let keys = Object.keys(obj);
        for (let i = 0, length = keys.length; i < length; i++) {
            iteratee(obj[keys[i]], keys[i], obj);
        }
        return
    }
    if(typeof obj.forEach == 'function'){
        obj.forEach(iteratee);
        return
    }

    let length = obj && obj.length;
    if(typeof length == 'number'){
        for (let i = 0; i < length; i++) {
            iteratee(obj[i], i, obj);
        }
        return;
    }

    return false;
}

utils.sortBy = (list, iteratee)=>{
    return list.map((value, index)=>{
        return {
            value,
            index,
            criteria: iteratee(value, index, array)
        };
    }).sort((left, right)=>{
        let a = left.criteria;
        let b = right.criteria;
        if (a !== b) {
            if (a > b || a === void 0) return 1;
            if (a < b || b === void 0) return -1;
        }
        return left.index - right.index;
    }).map(v=>v.value);
}

utils.merge = (dst, ...sources)=>{
    sources.forEach((src)=>{
        utils.each(src, (v, k)=>{
            if(utils.isArray(v)){
                dst[k] = [];
                utils.merge(dst[k], v);
            }else if(utils.isObject(v)) {
                if(!dst[k] || utils.isString(dst[k]) || !utils.isObject(dst[k]))
                    dst[k] = { };
                utils.merge(dst[k], v);
            }else{
                if(utils.isArray(src))
                    dst.push(v);
                else
                    dst[k] = v;
            }
        })
    })
    return dst;
}

utils.match = (text, regexp) => {
    return ((text && text.match(regexp) || {}).groups || {});
}

utils.clone = (o) => {
    return JSON.parse(JSON.stringify(o));
}


utils.args = (args) => {
    args = args || process.argv.slice(2);

    let argsRegex = null;
    try {
        argsRegex = new RegExp('^--(?<prop>[\\w-]+)(=(?<value>.+))?$');
    } catch(ex) { /*console.log(ex);*/ }

    let o = { }

    if(!argsRegex) {

        args.forEach((arg)=>{
            arg = arg.split('=');
            let k = arg.shift();
            let v = arg.shift();
            k = k.replace(/^--/,'');
            if(v !== undefined) o[k] = v; else o[k] = true;
        });

        return o;
    }


    args.map((arg) => {
        const { prop, value } = utils.match(arg,argsRegex);

        if(value == undefined)
            o[prop] = true;
        else
        if(o[prop]) {
            if(utils.isArray(o[prop]))
                o[prop].push(value);
            else
                o[prop] = [o[prop], value];
        }
        else {
            o[prop] = value;
        }
    })
    return o;
}

utils.unsignCookies = (obj, secret)=>{
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

utils.getClientIp = (req)=>{
    let ipAddress = req.query.ip;

    if(!ipAddress)
        ipAddress = req.header('CF-Connecting-IP');

    if(!ipAddress) {
        // This is cloud-flare based
        let forwardedIpsStr = req.header('X-Forwarded-For');
        if (forwardedIpsStr) {
            let forwardedIps = forwardedIpsStr.split(',');
            ipAddress = forwardedIps.pop();
        }
    }

    // If using nginx proxy, one must add the following directive to location
    // proxy_set_header X-Real-IP $remote_addr;
    if(!ipAddress)
        ipAddress = req.header('X-Real-IP');

    if (!ipAddress)
        ipAddress = req.connection.remoteAddress;

    return ipAddress;
}


utils.getConfig = (name, defaults = null)=>{
    let data = [ ];
    [name, name+'.'+os.hostname(), name+'.local'].forEach((filename) => {
        if(fs.existsSync(filename)) 
            data.push(fs.readFileSync(filename) || null);
    })

    if(!data[0] && !data[1]) {
        return defaults;
    }

    let o = defaults || { }
    data.forEach((conf) => {
        if(!conf || !conf.toString('utf-8').length)
            return;
        let layer = eval('('+conf.toString('utf-8')+')');
        utils.merge(o, layer);
    })

    return o;
}

utils.readJSON = filename=>{
    if(!fs.existsSync(filename))
        return undefined;
    var text = fs.readFileSync(filename, { encoding : 'utf-8' });
    if(!text)
        return undefined;
    try { 
        return JSON.parse(text); 
    } catch(ex) { 
        console.log("Error parsing file:",filename); 
        console.log(ex); 
        console.log('Offending content follows:',text); 
    }
    return undefined;
}

utils.getTS = src_date=>{
    var a = src_date || (new Date());
    var year = a.getFullYear();
    var month = a.getMonth()+1; month = month < 10 ? '0' + month : month;
    var date = a.getDate(); date = date < 10 ? '0' + date : date;
    var hour = a.getHours(); hour = hour < 10 ? '0' + hour : hour;
    var min = a.getMinutes(); min = min < 10 ? '0' + min : min;
    var sec = a.getSeconds(); sec = sec < 10 ? '0' + sec : sec;
    //var time = year + '-' + month + '-' + date + ' ' + hour + ':' + min + ':' + sec;
    return `${year}-${month}-${date} ${hour}:${min}:${sec}`;
}

utils.getExecTarget = (target) => {
    if(utils.platform.startsWith('windows'))
        target += '.exe';
    return path.join(utils.platform,target);
}


// shallow diff
utils.sdiff = (a,b) => {
    return Object.fromEntries(Object.entries(b).filter(([k,v])=>{
        return a[k] != b[k];
    }))
}