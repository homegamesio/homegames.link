const WebSocket = require('ws');
const http = require('http');
const process = require('process');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

// todo: move to common
const createDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const params = {
        ChangeBatch: {
            Changes: [
                {
                    Action: "CREATE", 
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
	    if (data.ResourceRecordSets.length === 0 || data.ResourceRecordSets[0].Name !== url) {
		    createDNSRecord(url, ip).then(() => {
	    		resolve();
		    });
	    } else {
	    	resolve();
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
        });

});

const app = (req, res) => {
//	const requesterIp = req.connection.remoteAddress; 

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

	    getHomegamesServers(requesterIp).then(servers => {
	    	const serverIds = servers && Object.keys(servers) || [];
	    	if (serverIds.length === 1) {
	    		const serverInfo = JSON.parse(servers[serverIds[0]]);
	    		const hasHttps = serverInfo.https;
	    		const prefix = hasHttps ? 'https' : 'http';
	    		const urlOrIp = serverInfo.verifiedUrl || serverInfo.localIp;
	    		res.writeHead(307, {
	    			'Location': `${prefix}://${urlOrIp}`,
	    			'Cache-Control': 'no-store'
	    		});
	    		res.end();
	    	} else if (serverIds.length > 1) {
	    		const serverOptions = serverIds.map(serverId => {
	    			const serverInfo = JSON.parse(servers[serverId]);

	    			const prefix = serverInfo.https ? 'https': 'http';
	    			const urlOrIp = serverInfo.verifiedUrl || serverInfo.localIp;
	    			const lastHeartbeat = new Date(Number(serverInfo.timestamp));
	    			return `<li><a href="${prefix}://${urlOrIp}"}>Server ID: ${serverId} (Last heartbeat: ${lastHeartbeat})</a></li>`
	    		});

	    		const content = `Homegames server selector: <ul>${serverOptions.join('')}</ul>`;
	    		const response = `<html><body>${content}</body></html>`;
	    		res.writeHead(200, {
	    			'Content-Type': 'text/html'
	    		});
	    		res.end(response);
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
	redisClient().then(client => {

	    client.hgetall(publicIp, (err, data) => {
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
	    		if (serverInfo.localIp && serverInfo.localIp === info.localIp || !serverInfo.timestamp || serverInfo.timestamp + (5 * 1000 * 60) <= Date.now()) {
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

const updatePresence = (publicIp, serverId) => {
    console.log(`updating presence for server ${serverId}`);
	getHostInfo(publicIp, serverId).then(hostInfo => {
		if (!hostInfo) {
                        console.warn(`no host info found for server ${serverId}`);
			return;
		}
		registerHost(publicIp, JSON.parse(hostInfo), serverId).then(() => {
                    console.log(`updated presence for server ${serverId}`);
		});
	});
};

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
        const publicIp = headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (!publicIp) {
            console.log(`No public IP found for websocket connection.`)
            return;
        }

        console.log(`registering socket client with id: ${ws.id}`);

        const socketId = generateSocketId();
	ws.id = generateSocketId();
	clients[ws.id] = ws;

	ws.on('message', (_message) => {
	   
		try {
            		const message = JSON.parse(_message);

			if (message.type === 'heartbeat') {
				updatePresence(publicIp, ws.id).then(logSuccess('updatePresence')).catch(logFailure('updatePresence'));
			} else if (message.type === 'register') {
				registerHost(publicIp, message.data, ws.id).then(logSuccess('registerHost')).catch(logFailure('registerHost'));
	    		} else if (message.type === 'verify-dns') {
				verifyAccessToken(message.username, message.accessToken).then(() => {
		    			const ipSub = message.localIp.replace(/\./g, '-');
					const userHash = getUserHash(message.username);
		    			const userUrl = `${ipSub}.${userHash}.homegames.link`;
					verifyDNSRecord(userUrl, message.localIp).then(() => {
						ws.send(JSON.stringify({
							msgId: message.msgId,
							url: userUrl,
							success: true
						}));
						updateHostInfo(publicIp, ws.id, {verifiedUrl: userUrl}).then(logSuccess('upateHostInfo')).catch(logFailure('updateHostInfo'));
					});
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

hostMapServer.listen(80);
//
//const HTTP_PORT = 80;
