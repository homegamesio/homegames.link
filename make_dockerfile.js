let config;
const fs = require('fs');

try {
    config = require('./config');
} catch(err) {
    config = {};
}

const envVars = [
    'AWS_ROUTE_53_HOSTED_ZONE_ID',
    'REDIS_HOST',
    'REDIS_PORT'
];

const envStrings = envVars.map(_var => {
    return `ENV ${_var}=${config[_var] || "\"\""}`;
});

const baseString = `
FROM node:14

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 80

${envStrings.join('\n')}

CMD [ "node", "server.js" ]
`;

fs.writeFileSync('_generatedDockerfile', baseString);
