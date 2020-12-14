const WebSocket = require('ws');
const config = require('./config');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getUserHash, verifyAccessToken } = require('homegames-common');
const AWS = require('aws-sdk');

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

const hostMapServer = https.createServer(options, (req, res) => {
	const requesterIp = req.connection.remoteAddress;

	if (hostMap[requesterIp]) {

	    res.writeHead(307, {
                'Location': `https://${hostMap[requesterIp].url}`,
                'Cache-Control': 'no-store'
            });
            res.end();
	} else {
		res.writeHead(200);
        	res.end('none');
    	}
});

// if this thing becomes popular, this will never work. until then, it's fine.
let id = 0;

const wss = new WebSocket.Server({server: wsServer});

const clients = {};
wss.on('connection', (ws, req) => {
	ws.id = id++;
	clients[ws.id] = ws;

        const networkIp = req.connection.remoteAddress;

	ws.on('message', (_info) => {

            const info = JSON.parse(_info);


	    verifyAccessToken(info.username, info.accessToken).then((data) => {
		    const ipSub = info.ip.replace(/\./g, '-');
		    const userHash = getUserHash(info.username);
		    const userUrl = `${ipSub}.${userHash}.homegames.link`;

		    verifyDNSRecord(userUrl, info.ip).then(() => {
		            hostMap[networkIp] = {
				    url: userUrl
			    };
		    }).catch(err => {
			    console.log(err);
		    });
	    });

	});

        ws.on('close', () => {
            delete hostMap[networkIp];
            delete clients[ws.id];
        });
});

hostMapServer.listen(443);
wsServer.listen(7080);
