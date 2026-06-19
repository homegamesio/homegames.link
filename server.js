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

// Real source IP as seen by our trusted nginx hop. nginx appends the connecting
// peer to any client-supplied X-Forwarded-For, so the RIGHTMOST entry is the
// trustworthy one; leftmost entries are attacker-controllable. Cert/DNS
// ownership is bound to this value, so it must not be spoofable.
// NOTE: assumes a single trusted proxy (nginx). Revisit if a CDN is added.
const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean);
        if (hops.length) return hops[hops.length - 1];
    }
    return (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress);
};

// Is this a private (RFC1918 / loopback / link-local / CGNAT) IPv4 address?
// register only maps a subdomain to a LAN IP, so we reject public IPs to avoid
// pointing *.homegames.link at arbitrary internet hosts.
const isPrivateIp = (ip) => {
    if (!ip || typeof ip !== 'string') return false;
    // Strip an IPv4-mapped IPv6 prefix (e.g. ::ffff:192.168.1.2)
    const v4 = ip.replace(/^::ffff:/i, '');
    const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some(n => n > 255)) return false;
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
};

// Single shared Redis client (Redis backs only the optional map/geo feature).
// Reused across calls so we don't leak a fresh TCP connection per register /
// disconnect. The 'error' handler is mandatory: a node-redis client with no
// 'error' listener throws an UNCAUGHT exception on connection failure, which
// would crash this process — and since Redis is optional here, an outage must
// degrade the map feature, not take down the redirect service.
const redisClient = redis.createClient({
	host: process.env.REDIS_HOST || '127.0.0.1',
	port: process.env.REDIS_PORT || 6379
});

redisClient.on('error', (err) => {
	console.error('Redis client error (map/geo feature degraded):');
	console.error(err);
});

const redisPutString = (key, val) => new Promise((resolve, reject) => {
	redisClient.set(key, val, (err) => {
		if (!err) {
			resolve();
		} else {
			reject(err);
		}
	});
});

const redisDelete = (key) => new Promise((resolve, reject) => {
	redisClient.del(key, (err) => {
		if (!err) {
			resolve();
		} else {
			reject(err);
		}
	});
});

/* DEPRECATED — previous per-call client (leaked a connection on every call and
   had no error handler, so a Redis outage crashed the process):
const redisPutString = (key, val) => new Promise((resolve, reject) => {
	const client = redis.createClient();
	client.on('connect', () => {
		client.set(key, val, (err) => { if (!err) { resolve(); } else { reject(err); } });
	});
});
const redisDelete = (key) => new Promise((resolve, reject) => {
	const client = redis.createClient();
	client.on('connect', () => {
		client.del(key, (err) => { if (!err) { resolve(); } else { reject(err); } });
	});
});
*/

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
	    // Reject on error instead of silently reporting success — callers
	    // (e.g. register) rely on this to decide whether the DNS record really
	    // exists before trusting it / advertising verifiedUrl.
	    if (err) {
		    reject(err);
	    } else {
		    resolve(data);
	    }
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

// Page shown when an instance is present on this network but its HTTPS cert/DNS
// is still provisioning. Auto-refreshes so the browser lands on the secure
// instance as soon as it's ready. Distinct from the "no servers found" page:
// presence in the discovery cache means an instance exists, httpsReady=false
// means it just isn't serving HTTPS yet.
const settingUpPage = () => {
    const content = `Your Homegames instance is setting up a secure connection. This page will refresh automatically.`;
    return `<html><head><meta http-equiv="refresh" content="5"><title>Homegames - setting up</title></head><body>${content}</body></html>`;
};

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
            // NOTE: removed a premature res.writeHead(200) here — each branch below
            // now writes its own status (307 redirect / 200 selector / 200 setting-up),
            // and writing the header twice throws ERR_HTTP_HEADERS_SENT.
            // res.writeHead(200, {
	        // 'Content-Type': 'text/plain'
	    // });

            const requesterIp = getClientIp(req);

            console.log("REQUESTER IP " + requesterIp);

	    getHomegamesServers(requesterIp).then(servers => {
	    	const serverIds = servers && Object.keys(servers) || [];
	    	if (serverIds.length === 1) {
	    		const serverInfo = servers[serverIds[0]];
                        console.log("THIS IS SERVER INFO");
                        console.log(serverInfo);

                        // httpsEnabled: instance intends to serve HTTPS.
                        // httpsReady:   cert installed AND HTTPS server actually up.
                        // Fall back to the legacy single `https` boolean for older
                        // clients that don't report the split fields yet (in which
                        // case "enabled" implies "ready").
                        const httpsEnabled = serverInfo.httpsEnabled !== undefined ? serverInfo.httpsEnabled : serverInfo.https;
                        const httpsReady = serverInfo.httpsReady !== undefined ? serverInfo.httpsReady : serverInfo.https;

                        if (!httpsEnabled) {
                            // Plain-HTTP instance — ready now, redirect to the local IP.
                            res.writeHead(307, {
                                'Location': `http://${serverInfo.localIp}`,
                                'Cache-Control': 'no-store'
                            });
                            res.end();
                        } else if (!httpsReady) {
                            // HTTPS intended but cert/DNS not provisioned yet.
                            res.writeHead(200, {
                                'Content-Type': 'text/html',
                                'Cache-Control': 'no-store'
                            });
                            res.end(settingUpPage());
                        } else if (serverInfo.verifiedUrl) {
                            // HTTPS ready and the DNS record was confirmed at register
                            // time (verifiedUrl set only after a successful createDNSRecord).
                            // Redirect straight from cache — no Route53 call on the hot path.
                            res.writeHead(307, {
                                'Location': `https://${serverInfo.verifiedUrl}`,
                                'Cache-Control': 'no-store'
                            });
                            res.end();
                        } else {
                            // HTTPS intended and ready, but the DNS record isn't confirmed
                            // yet — treat as still setting up rather than redirecting to a
                            // name that won't resolve to this instance.
                            res.writeHead(200, {
                                'Content-Type': 'text/html',
                                'Cache-Control': 'no-store'
                            });
                            res.end(settingUpPage());
                        }

                        /* DEPRECATED — previous single-server logic, replaced by the
                           httpsEnabled/httpsReady three-way handling above.
                        let ret = serverInfo.localIp;
                        const hasHttps = serverInfo.https;
	    		const prefix = hasHttps ? 'https' : 'http';
                        if (hasHttps) {
                            const hash = getUserHash(requesterIp);
                            getLinkRecord(`${hash}.homegames.link`).then(record => {
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
                        */
	    	} else if (serverIds.length > 1) {
	    		Promise.all(serverIds.map(serverId => new Promise((resolve, reject) => {
	    			const serverInfo = servers[serverId];

	    			const lastHeartbeat = new Date(Number(serverInfo.timestamp));

                                // Use the DNS hostname confirmed at register time (verifiedUrl)
                                // so the selector links to the secure subdomain without any
                                // Route53 call on the hot path; fall back to the raw local IP
                                // (http) when it isn't confirmed yet. Always resolves, so the
                                // selector page can't hang on a missing/mismatched record.
                                const ret = serverInfo.verifiedUrl || (serverInfo && serverInfo.localIp);
                                const prefix = serverInfo.verifiedUrl ? 'https' : 'http';

                                resolve(`<li><a href="${prefix}://${ret}">Server ID: ${serverId} (Last heartbeat: ${lastHeartbeat})</a></li>`);

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
        const publicIp = getClientIp(req);

        if (!publicIp) {
            console.log(`No public IP found for websocket connection.`)
            return;
        }

        const socketId = generateSocketId();

	ws.id = socketId;

	clients[ws.id] = ws;
	let mapEnabled = false;

        console.log(`registering socket client with id: ${ws.id}`);

        let receivedRegister = false;
        // if they havent sent us a message in 15 seconds since connecting, close the connection
        setTimeout(() => {
            if (!receivedRegister) {
                ws.close();
            }
        }, 5 * 1000);

	ws.on('message', (_message) => {
	   
		try {
            		const message = JSON.parse(_message);

			if (message.type === 'heartbeat') {
				updatePresence(publicIp, ws.id).then(() => logSuccess('updatePresence')).catch(() => logFailure('updatePresence'));
			} else if (message.type === 'register') {
                                console.log('this is message');
                                console.log(message);
                                // Mark this connection as registered so the 5s
                                // idle-disconnect timeout doesn't kill it.
                                receivedRegister = true;
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
                                // The subdomain is keyed on the REAL public IP (publicIp
                                // comes from getClientIp -> nginx hop, not spoofable), so a
                                // client can only map its own network's subdomain. We also
                                // require localIp to be a private/LAN address so the record
                                // can't be pointed at an arbitrary public host.
                                if (!isPrivateIp(localIp)) {
                                    console.error('Refusing to register non-private localIp ' + localIp + ' for public ip ' + publicIp);
                                } else {
                                    const dnsName = `${getUserHash(publicIp)}.homegames.link`;
                                    createDNSRecord(dnsName, localIp).then(() => {
                                        console.log('created dns record!');
                                        // Stash the now-confirmed hostname so app() can redirect
                                        // straight from cache instead of hitting Route53 on every
                                        // browser request. Only set after a SUCCESSFUL create, so
                                        // a failed write (now rejects) won't advertise a bad URL.
                                        message.data.verifiedUrl = dnsName;
				        registerHost(publicIp, message.data, ws.id).then(() => logSuccess('registerHost')).catch(() => logFailure('registerHost'));
                                    }).catch(err => {
                                        console.error('failed to create dns record');
                                        console.error(err);
                                    });
                                }
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
