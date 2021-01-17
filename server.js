const WebSocket = require('ws');
const config = require('./config');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid');

const hostMap = {};

const options = {
    key: fs.readFileSync(config.SSL_KEY_PATH),
    cert: fs.readFileSync(config.SSL_CERT_PATH)
};

const wsServer = https.createServer(options);


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
        HostedZoneId: config.aws.route53.HOSTED_ZONE_ID
    };

    const route53 = new AWS.Route53();
    
    route53.changeResourceRecordSets(params, (err, data) => {
	    resolve();
    });
});

const verifyDNSRecord = (url, ip) => new Promise((resolve, reject) => {
    const route53 = new AWS.Route53();

    const params = {
        HostedZoneId: config.aws.route53.HOSTED_ZONE_ID,
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

const COGNITO_POOL_DATA = {
    UserPoolId: config.aws.cognito.USER_POOL_ID,
    ClientId: config.aws.cognito.CLIENT_ID
};

const getAccessToken = (username, password) => new Promise((resolve, reject) => {
    const params = new Cognito.AuthenticationDetails({
	Username: username,
	Password: password
    });

    const userPool = new Cognito.CognitoUserPool(COGNITO_POOL_DATA);

    const userData = {
        Username: username,
	Pool: userPool
    };

    const user = new Cognito.CognitoUser(userData);

    user.authenticateUser(params, {
        onSuccess: (result) => {
            resolve(result.getAccessToken().getJwtToken());
	},
	onFailure: (err) => {
            reject(err);
	}
    });
});

const redisClient = () => {
	return redis.createClient({
		host: config.REDIS_HOST,
		port: config.REDIS_PORT
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

const getHostInfo = (ip) => new Promise((resolve, reject) => {
	const client = redisClient();

	client.hmget(publicIp, [hostIp], (err, data) => {
		if (err || !data) {
			reject(err || 'No host data found');
		} else {
			resolve(data);
		}
	});

});

const app = (req, res) => {
	const requesterIp = req.connection.remoteAddress;

	const noServers = () => {
		res.writeHead(200, {
			'Content-Type': 'text/plain'
		});
		res.end('No Homegames servers found. Contact support@homegames.io for help');
	};

	getHomegamesServers(requesterIp).then(servers => {
		const serverIds = Object.keys(servers);
		if (serverIds.length === 1) {
			const serverInfo = JSON.parse(Object.values(servers)[0]);
			const hasHttps = serverInfo.https;
			const prefix = hasHttps ? 'https' : 'http';
			res.writeHead(307, {
				'Location': `${prefix}://${serverInfo.ip}`,
				'Cache-Control': 'no-store'
			});
			res.end();
		} else if (serverIds.length > 1) {
			const serverOptions = serverIds.map(serverId => {
				const serverInfo = JSON.parse(servers[serverId]);

				const prefix = serverInfo.https ? 'https': 'http';
				return `<li><a href="${prefix}://${serverInfo.ip}"}>Server ID: ${serverId}</a></li>`
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

const hostMapServer = https.createServer(options, app);
//(req, res) => {
//	const requesterIp = req.connection.remoteAddress;
//
//	console.log("GOT IP");
//	console.log(requesterIp);
//
//	console.log("THINGS");
//
//	const redisClient = redis.createClient();
//
//	redisClient.set("testkey", "testvalue", (err, res) => {
//		console.log("yooooo");
//		console.log(err);
//		console.log(res);
//		redisClient.get("testkey", (err, res) => {
//			console.log(err);
//			console.log(res);
//		});
//	});
//
//
////	if (hostMap[requesterIp]) {
////	
////	    res.writeHead(307, {
////                'Location': `https://${hostMap[requesterIp].url}`,
////                'Cache-Control': 'no-store'
////            });
////            res.end();
////	} else {
////		res.writeHead(200);
////        	res.end('none');
////    	}
//});

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
		client.hmset(publicIp, [hostId, JSON.stringify(info)], (err, data) => {
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

			if (serverInfo.ip === info.ip) {
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

wss.on('connection', (ws, req) => {
	const socketId = generateSocketId();
	ws.id = generateSocketId();
	clients[ws.id] = ws;

        const publicIp = req.connection.remoteAddress;

	ws.on('message', (_message) => {
	   
		try {
            		const message = JSON.parse(_message);

	    		if (message.ip) {
				registerHost(publicIp, message, ws.id).then(() => {
					console.log('registered host');
				});
	    		} else {
	    		    console.log("received message without ip");
	    		    console.log(message);
	    		}
		} catch (err) {
			console.log("Error processing client message");
			console.error(err);
		}


//	    verifyAccessToken(info.username, info.accessToken).then((data) => {
//		    const ipSub = info.ip.replace(/\./g, '-');
//		    const userHash = getUserHash(info.username);
//		    const userUrl = `${ipSub}.${userHash}.homegames.link`;
//
//		    console.log("HELLOG GOO");
//		    console.log(userUrl);
//		    console.log(info.ip);
//
//		    verifyDNSRecord(userUrl, info.ip).then(() => {
//		            hostMap[networkIp] = {
//				    url: userUrl
//			    };
//		    }).catch(err => {
//			    console.log(err);
//		    });
//	    });

	});

        ws.on('close', () => {
            delete clients[ws.id];

		deleteHostInfo(publicIp, ws.id).then(() => {
			console.log('deleetedede');
		});
//	    getHostInfo(publicIp).then(_hostInfo => {
//		console.log('host info of person who just closed');
//		console.log(_hostInfo);
//		if (_hostInfo) {
//			const hostInfo = JSON.parse(_hostInfo);
//			deleteHostInfo(publicIp, hostInfo.ip).then(() => {
//				console.log("deleted host info");
//			});
//		}
//	    });
	    //deleteHostInfo(hostIp, 
            //delete hostMap[networkIp]; 
        });
});

hostMapServer.listen(443);
wsServer.listen(7080);

const HTTP_PORT = 80;

http.createServer((req, res) => {
    res.writeHead(301, {'Location': 'https://' + req.headers['host'] + req.url });
    res.end();
}).listen(HTTP_PORT);
