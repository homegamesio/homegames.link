const WebSocket = require('ws');
const http = require('http');
const process = require('process');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

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

const redisClient = () => new Promise((resolve, reject) => {
    setTimeout(() => {
        reject('Redis connection timed out');
    }, 30 * 1000);
	const client = redis.createClient({
		host: process.env.REDIS_HOST,
		port: process.env.REDIS_PORT
	}).on('error', (err) => {
            reject(err);
        }).on('ready', () => {
            resolve(client);
        });
});

const redisGet = (key) => new Promise((resolve, reject) => {
	redisClient().then(client => {
	    client.get(key, (err, res) => {
	    	if (err) {
	    		reject(err);
	    	} else {
	    		resolve(res);
	    	}
	    });
        });
});

const redisSet = (key, value) => new Promise((resolve, reject) => {	
	redisClient().then(client => {
	    client.set(key, value, (err, res) => {
	    	if (err) {
	    		reject(err);
	    	} else {
	    		resolve(res);
	    	}
	    });
        });

});

const redisHmset = (key, obj) => new Promise((resolve, reject) => {
	redisClient().then(client => {
	    client.get(key, (err, res) => {
	    	if (err) {
	    		reject(err);
	    	} else {
	    		resolve(res);
	    	}
	    });
        });
});

const getHostInfo = (publicIp, serverId) => new Promise((resolve, reject) => {
	redisClient().then(client => {
	    client.hmget(publicIp, [serverId], (err, data) => {
	    	if (err || !data) {
	    		reject(err || 'No host data found');
	    	} else {
	    		resolve(data[0]);
	    	}
	    });
        }).catch(err => {
            console.error('failed to get redis client');
            console.error(err);
        });

});

const app = (req, res) => {
//	const requesterIp = req.connection.remoteAddress; 
    
        console.log('got a request to ' + req.url + ' (' +  req.method + ')');
        const { headers } = req;

	const noServers = () => {
		res.writeHead(200, {
			'Content-Type': 'text/plain'
		});
		res.end('No Homegames servers found. Contact support@homegames.io for help');
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
	    		const serverInfo = JSON.parse(servers[serverIds[0]]);
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
	    			const serverInfo = JSON.parse(servers[serverId]);

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


// Redis key structure
//{
//  "publicIp": {
//    "serverId1": {
//      ...
//    },
//    "serverId2": {
//	...
//    },
//    ...
//  }
//}
const getHomegamesServers = (publicIp) => new Promise((resolve, reject) => {
        console.log('getting homegames servers!');
	redisClient().then(client => {

	    client.hgetall(publicIp, (err, data) => {
                console.log("HERE ARE SERVERS");
                console.log(data);
	    	if (err) {
	    		reject(err);
	    	} else {
	    		resolve(data);
	    	}
	    });
        });
});

const deleteHostInfo = (publicIp, localIp) => new Promise((resolve, reject) => {
        redisClient().then(client => {

	    client.hdel(publicIp, [localIp], (err, data) => {
	    	if (err) {
	    		reject(err);
	    	} else {
	    		resolve();
	    	}
	    });
        });
});

const registerHost = (publicIp, info, hostId) => new Promise((resolve, reject) => {
        console.log('registering host with public ip ' + publicIp);
        console.log(info);
	redisClient().then(client => {

	    const doUpdate = () => {
	    	const payload = Object.assign({}, info);
	    	payload.timestamp = Date.now();
	    	client.hmset(publicIp, [hostId, JSON.stringify(payload)], (err, data) => {
	    		if (err) {
	    			reject(err);
	    		} else {
	    			resolve();
	    		}
	    	});
	    }

	    // clear out existing entries
	    client.hgetall(publicIp, (err, data) => {
	    	const idsToRemove = [];
	    	for (serverId in data) {
	    		const serverInfo = JSON.parse(data[serverId]);
                        if (!serverInfo) {
                            idsToRemove.push(serverId);
                        } else if (serverInfo.localIp && serverInfo.localIp === info.localIp || !serverInfo.timestamp || serverInfo.timestamp + (5 * 1000 * 60) <= Date.now()) {
	    			idsToRemove.push(serverId);
	    		}
	    	}

	    	let toDeleteCount = idsToRemove.length;

	    	if (toDeleteCount === 0) {
	    		doUpdate();
	    	} else {

	    		for (const idIndex in idsToRemove) {
	    			const id = idsToRemove[idIndex];

	    			client.hdel(publicIp, [id], (err, data) => {
	    				toDeleteCount -= 1;
	    				if (toDeleteCount == 0) {
	    					doUpdate();
	    				}
	    			});
	    		}
	    	}
	    });
        });
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
		registerHost(publicIp, JSON.parse(hostInfo), serverId).then(() => {
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
		const newInfo = Object.assign(JSON.parse(hostInfo), update);
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
		});
        });
});

console.log("ABOUT TO LISTEN");

hostMapServer.listen(80);
//
//const HTTP_PORT = 80;
