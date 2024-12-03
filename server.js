const WebSocket = require('ws');
const redis = require('redis');
const http = require('http');
const process = require('process');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const geoip = require('geoip-lite');

const getCountryByIp = (ip) => {
    const geo = geoip.lookup(ip);
    if (geo && geo.country) {
        return geo.country;
    }

    return null;
};

const getHash = (input) => {
    return crypto.createHash('md5').update(input).digest('hex');
};

const redisPutString = (key, val) => new Promise((resolve, reject) => {
	const client = redis.createClient();	
	client.on('connect', () => {
		console.log('connected for put');
		client.set(key, val, (err) => {
			if (!err) {
				resolve();
			} else {
				reject(err);
			}
		});
	});
});

const redisDelete = (key) => new Promise((resolve, reject) => {
	const client = redis.createClient();	
	client.on('connect', () => {
		console.log('connected for delete');
		client.del(key, (err) => {
			console.log('cool deleted');
			if (!err) {
				resolve();
			} else {
				reject(err);
			}
		});
	});

});

const getLinkRecord = (name, throwOnEmpty) => new Promise((resolve, reject) => {
    const params = {
        HostedZoneId: process.env.AWS_ROUTE_53_HOSTED_ZONE_ID,
        StartRecordName: name,
        StartRecordType: 'A'
    };

    const route53 = new AWS.Route53();
    route53.listResourceRecordSets(params, (err, data) => {
        if (err) {
            console.error('error listing record sets');
            console.error(err);
            reject(err);
        } else {
            for (const i in data.ResourceRecordSets) {
                const entry = data.ResourceRecordSets[i];
                if (entry.Name === name + '.') {
                    resolve(entry.ResourceRecords[0].Value);
                }
            }
            throwOnEmpty ? reject() : resolve(null);
        }
    });

});

// todo: move to common
const createDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const params = {
        ChangeBatch: {
            Changes: [
                {
                    Action: "UPSERT", 
                    ResourceRecordSet: {
                        Name: url,
                        ResourceRecords: [
                            {
                                Value: ip
                            }
                        ], 
                        TTL: 60, 
                        Type: "A"
                    }
                }
            ]
        }, 
        HostedZoneId: process.env.AWS_ROUTE_53_HOSTED_ZONE_ID
    };

    const route53 = new AWS.Route53();
    
    route53.changeResourceRecordSets(params, (err, data) => {
	    resolve();
    });
});

const verifyDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const route53 = new AWS.Route53();

    const params = {
        HostedZoneId: process.env.AWS_ROUTE_53_HOSTED_ZONE_ID,
        StartRecordName: url,
        StartRecordType: 'A',
	MaxItems: '1'
    };
    
    route53.listResourceRecordSets(params, (err, data) => {
            if (err) {
                console.log("error");
                console.error(err);
                reject();
            } else {
	        if (data.ResourceRecordSets.length === 0 || data.ResourceRecordSets[0].Name !== url) {
	                createDNSRecord(url, ip).then(() => {
	        		resolve();
	                });
	        } else {
	        	resolve();
	        }
            }
    });
});

const getHostInfo = (publicIp, serverId) => new Promise((resolve, reject) => {
	const publicIpInfo = cache.get(publicIp);
	if (publicIpInfo) {
		console.log('something there');
		console.log(publicIpInfo);
		const parsed = publicIpInfo;
		if (parsed[serverId]) {
			console.log('someoeeoeoeoeo');
			console.log(parsed);
			resolve(parsed[serverId]);
		} else {
			resolve({});
		}
	} else {
		resolve({});
	}
});

const app = (req, res) => {
//	const requesterIp = req.connection.remoteAddress; 
    
        console.log('got a request to ' + req.url + ' (' +  req.method + ')');
        const { headers } = req;

	const noServers = () => {
		res.writeHead(200, {
			'Content-Type': 'text/plain'
		});
                //                res.writeHead(307, {
	    	//	    	    'Location': `https://public.homegames.link`,
	    	//	    	    'Cache-Control': 'no-store'
	    	//	        });
//	    		        res.end();
                res.end('No Homegames servers found. Contact joseph@homegames.io for support'); 
	};

        if (!headers) {
            noServers();
        } else {
            res.writeHead(200, {
	        'Content-Type': 'text/plain'
	    });

            const requesterIp = headers['x-forwarded-for'] || req.connection.remoteAddress;

            console.log("REQUESTER IP " + requesterIp);

	    getHomegamesServers(requesterIp).then(servers => {
	    	const serverIds = servers && Object.keys(servers) || [];
	    	if (serverIds.length === 1) {
	    		const serverInfo = servers[serverIds[0]];
                        console.log("THIS IS SERVER INFO");
                        console.log(serverInfo);
                        
                        let ret = serverInfo.localIp;
	    		
                        const hasHttps = serverInfo.https;
	    		const prefix = hasHttps ? 'https' : 'http';

                        if (hasHttps) {//.username) {
                            console.log("THIS IS USERNAME!");
//                            console.log(serverInfo.username);
  //                          console.log(serverInfo.uesrname + serverInfo.localIp);
                            const hash = getUserHash(requesterIp);//serverInfo.username + serverInfo.localIp);
                            getLinkRecord(`${hash}.homegames.link`).then(record => {
                                console.log("HERE IS THE RECORD AT THAT THING " + hash);
                                console.log(record);
                                if (record && record === serverInfo.localIp) {
                                    ret = `${hash}.homegames.link`;
                                }
                                res.writeHead(307, {
	    		    	    'Location': `${prefix}://${ret}`,
	    		    	    'Cache-Control': 'no-store'
	    		        });
	    		        res.end();
                            });
                        } else {
	    		    res.writeHead(307, {
	    		    	'Location': `${prefix}://${ret}`,
	    		    	'Cache-Control': 'no-store'
	    		    });
	    		    res.end();
                        }
	    	} else if (serverIds.length > 1) {
	    		Promise.all(serverIds.map(serverId => new Promise((resolve, reject) => {
	    			const serverInfo = servers[serverId];

	    			const lastHeartbeat = new Date(Number(serverInfo.timestamp));

	    			const prefix = serverInfo.https ? 'https': 'http';
                                let ret = serverInfo && serverInfo.localIp;

                                if (serverInfo.username) {
                                    const hash = getUserHash(requesterIp);//serverInfo.username + serverInfo.localIp);
                                    getLinkRecord(`${hash}.homegames.link`).then(record => {
                                        if (record && record === serverInfo.localIp) {
                                            ret = `${hash}.homegames.link`;
	    			            resolve(`<li><a href="${prefix}://${ret}"}>Server ID: ${serverId} (Last heartbeat: ${lastHeartbeat})</a></li>`);
                                        }
                                    });
                                } else {
                                    resolve(`<li><a href="${prefix}://${ret}"}>Server ID: ${serverId} (Last heartbeat: ${lastHeartbeat})</a></li>`);
                                }

                        }))).then(serverOptions => {
	    		    const content = `Homegames server selector: <ul>${serverOptions.join('')}</ul>`;
	    		    const response = `<html><body>${content}</body></html>`;
	    		    res.writeHead(200, {
	    		    	'Content-Type': 'text/html'
	    		    });
	    		    res.end(response);
                        });
	    	} else {
	    		console.log('no servers');
	    		noServers();
	    	}

	}).catch(err => {
		console.log('Error getting host info');
		console.log(err);
		noServers();
	});
    }
};

const hostMapServer = http.createServer(app);

const wss = new WebSocket.Server({ server: hostMapServer });

const clients = {};

class Cache {
	constructor() {
		this.cache = {};
	}

	set(key, val) { 
		this.cache[key] = val;
	}

	get(key) {
		return this.cache[key];
	}
}

const cache = new Cache();

const getHomegamesServers = (publicIp) => new Promise((resolve, reject) => {
        console.log('getting homegames servers!');
	const serverOptions = cache.get(publicIp);
	if (serverOptions) {
		console.log("these are op[tions");
		console.log(serverOptions);
		resolve(serverOptions);
	} else {
		resolve({});
	}
});

const deleteHostInfo = (publicIp, localIp) => new Promise((resolve, reject) => {
	const currentMappings = cache.get(publicIp);
	if (currentMappings) {
		if (currentMappings[localIp]) {
			const newMappings = Object.assign({}, currentMappings);
			delete newMappings[localIp];
			cache.set(publicIp, newMappings);
		}
		resolve();
	} else {
		resolve();
	}
});

const registerHost = (publicIp, info, hostId) => new Promise((resolve, reject) => {
        console.log('registering host with public ip ' + publicIp);
        console.log(info);
	const currentMappings = cache.get(publicIp);
	if (currentMappings) {
		const newVals = Object.assign({}, currentMappings);
		const toCache = Object.assign({}, info);
		toCache.hostId = hostId;
		toCache.timestamp = Date.now();
	
		newVals[hostId] = toCache;

		cache.set(publicIp, newVals);
		resolve();
	} else {
		const toCache = Object.assign({}, info);
		toCache.hostId = hostId;
		toCache.timestamp = Date.now();
		console.log("caching");
		console.log(toCache);
		cache.set(publicIp, { [hostId]: toCache });	
		resolve();
	}
});

const generateSocketId = () => {
	return uuidv4();
};

const updatePresence = (publicIp, serverId) => new Promise((resolve, reject) => {
    console.log(`updating UPDATED presence for server ${serverId}`);
	getHostInfo(publicIp, serverId).then(hostInfo => {
		if (!hostInfo) {
                        console.warn(`no host info found for server ${serverId}`);
                        reject();
		}
		registerHost(publicIp, hostInfo, serverId).then(() => {
                    console.log(`updated presence for server ${serverId}`);
                    resolve();
		});
	}).catch(err => {
            console.error('error getting host info');
            console.error(err);
            reject(err);
        });      
});

const updateHostInfo = (publicIp, serverId, update) => new Promise((resolve, reject) => {
        console.log(`updating host info for server ${serverId}`);
	getHostInfo(publicIp, serverId).then(hostInfo => {
		const newInfo = Object.assign(hostInfo, update);
		registerHost(publicIp, newInfo, serverId).then(() => {
                    console.log(`updated host info for server ${serverId}`);
                    resolve();
		}).catch(err => {
                    console.error(`failed to update host info for server ${serverId}`);
                    console.error(err);
                    reject();
                });
	});
});

const logSuccess = (funcName) => {
    console.error(`function ${funcName} succeeded`);
};

const logFailure = (funcName) => {
    console.error(`function ${funcName} failed`);
};

wss.on('connection', (ws, req) => {
        const publicIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (!publicIp) {
            console.log(`No public IP found for websocket connection.`)
            return;
        }

        const socketId = generateSocketId();

	ws.id = socketId;

	clients[ws.id] = ws;
	let mapEnabled = false;

        console.log(`registering socket client with id: ${ws.id}`);

	ws.on('message', (_message) => {
	   
		try {
            		const message = JSON.parse(_message);

			if (message.type === 'heartbeat') {
				updatePresence(publicIp, ws.id).then(() => logSuccess('updatePresence')).catch(() => logFailure('updatePresence'));
			} else if (message.type === 'register') {
                                console.log('this is message');
                                console.log(message);
                                const localIp = message.data.localIp;
                                const username = message.data.username;
				mapEnabled = message.data.mapEnabled;
				if (mapEnabled) {
					console.log('sickk');
					// todo: there will be a list of sessions on this server
					const countryCode = getCountryByIp(publicIp);
					if (countryCode) {
						redisPutString(getHash(publicIp), JSON.stringify({"country": countryCode, "sessions": []})).then(() => {
							console.log("stored. an async job will update the computed response");
						});
					}
				}
                                //if (!localIp || !username) {
                                //    console.error('Not registering server with public ip ' + publicIp);
                                //    console.error(message);
                                //} else {
                                    createDNSRecord(`${getUserHash(publicIp)}.homegames.link`, localIp).then(() => {
                                        console.log('created dns record!');
				        registerHost(publicIp, message.data, ws.id).then(() => logSuccess('registerHost')).catch(() => logFailure('registerHost'));
                                    }).catch(err => {
                                        console.error('failed to create dns record');
                                        console.error(err);
                                    });
                                //}
	    		} else if (message.type === 'verify-dns') {
                                console.log('verifying dns for user ' + message.username);
				verifyAccessToken(message.username, message.accessToken).then(() => {
					const userHash = getUserHash(publicIp);//message.username + message.localIp);
		    			const userUrl = `${userHash}.homegames.link`;
					verifyDNSRecord(userUrl, message.localIp).then(() => {
						ws.send(JSON.stringify({
							msgId: message.msgId,
							url: userUrl,
							success: true
						}));
						updateHostInfo(publicIp, ws.id, {verifiedUrl: userUrl}).then(() => logSuccess('upateHostInfo')).catch(() => logFailure('updateHostInfo'));
					}).catch(() => logFailure('verifyDNSRecord'));
				}).catch(err => {
                                    console.log("Failed to verify access token for user " + message.username);
                                    console.error(err);
                                    ws.send(JSON.stringify({
                                        msgId: message.msgId,
                                        success: false,
                                        error: 'Failed to verify access token'
                                    }));
                                    logFailure('verifyAccessToken');
                                });
			} else {
	    		    console.log("received message without ip");
	    		    console.log(message);
	    		}
		} catch (err) {
			console.log("Error processing client message");
			console.error(err);
		}

	});

        ws.on('close', () => {
            console.log(`deregistering socket client with id: ${ws.id}`);

            clients[ws.id] && delete clients[ws.id];

		deleteHostInfo(publicIp, ws.id).then(() => {
                    console.log(`deregistered socket client with id: ${ws.id}`);
			if (mapEnabled) {
				redisDelete(getHash(publicIp));
			}
		});
        });
});

console.log("ABOUT TO LISTEN");

hostMapServer.listen(process.env.PORT || 8000);
