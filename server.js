const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

const wsServer = http.createServer();


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

const redisClient = () => {
	return redis.createClient({
		host: process.env.REDIS_HOST,
		port: process.env.REDIS_PORT
	});
};

const redisGet = (key) => new Promise((resolve, reject) => {
	const client = redisClient();

	client.get(key, (err, res) => {
		if (err) {
			reject(err);
		} else {
			resolve(res);
		}
	});
});

const redisSet = (key, value) => new Promise((resolve, reject) => {	
	const client = redisClient();

	client.set(key, value, (err, res) => {
		if (err) {
			reject(err);
		} else {
			resolve(res);
		}
	});

});

const redisHmset = (key, obj) => new Promise((resolve, reject) => {
	const client = redisClient();

	client.get(key, (err, res) => {
		if (err) {
			reject(err);
		} else {
			resolve(res);
		}
	});
});

const getHostInfo = (publicIp, serverId) => new Promise((resolve, reject) => {
	const client = redisClient();

	client.hmget(publicIp, [serverId], (err, data) => {
		if (err || !data) {
			reject(err || 'No host data found');
		} else {
			resolve(data[0]);
		}
	});

});

const app = (req, res) => {
	const requesterIp = req.connection.remoteAddress;
        

	const noServers = () => {
		res.writeHead(200, {
			'Content-Type': 'text/plain'
		});
		res.end('No Homegames servers found. Contact support@homegames.io for help ' + requesterIp);
	};
        console.log(requesterIp);
        noServers();

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
};

const hostMapServer = http.createServer(app);

const wss = new WebSocket.Server({server: wsServer});

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
	const client = redisClient();

	client.hgetall(publicIp, (err, data) => {
		if (err) {
			reject(err);
		} else {
			resolve(data);
		}
	});
});

const deleteHostInfo = (publicIp, localIp) => new Promise((resolve, reject) => {
	const client = redisClient();

	client.hdel(publicIp, [localIp], (err, data) => {
		if (err) {
			reject(err);
		} else {
			resolve();
		}
	});
});

const registerHost = (publicIp, info, hostId) => new Promise((resolve, reject) => {
	const client = redisClient();

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

const generateSocketId = () => {
	return uuidv4();
};

const updatePresence = (publicIp, serverId) => {
	getHostInfo(publicIp, serverId).then(hostInfo => {
		if (!hostInfo) {
			return;
		}
		registerHost(publicIp, JSON.parse(hostInfo), serverId).then(() => {
			console.log('updated presence');
		});
	});
};

const updateHostInfo = (publicIp, serverId, update) => new Promise((resolve, reject) => {
	getHostInfo(publicIp, serverId).then(hostInfo => {
		const newInfo = Object.assign(JSON.parse(hostInfo), update);
		registerHost(publicIp, newInfo, serverId).then(() => {
			console.log('updated data');
		});
	});
});

wss.on('connection', (ws, req) => {
	const socketId = generateSocketId();
	ws.id = generateSocketId();
	clients[ws.id] = ws;

        const publicIp = req.connection.remoteAddress;

	ws.on('message', (_message) => {
	   
		try {
            		const message = JSON.parse(_message);

			if (message.type === 'heartbeat') {
				updatePresence(publicIp, ws.id);
			} else if (message.type === 'register') {
				registerHost(publicIp, message.data, ws.id).then(() => {
					console.log('registered host');
				});
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
						updateHostInfo(publicIp, ws.id, {verifiedUrl: userUrl});
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
            delete clients[ws.id];

		deleteHostInfo(publicIp, ws.id).then(() => {
			console.log('deleetedede');
		});
        });
});

hostMapServer.listen(80);
wsServer.listen(7080);

const HTTP_PORT = 80;
