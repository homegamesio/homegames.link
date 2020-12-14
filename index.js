const redis = require('redis');

exports.handler = async (event) => new Promise((resolve, reject) => {
  
    const client = redis.createClient({
        url: process.env.REDIS_URL
    });
    
    client.on('connect', () => {
        client.set('counter', 420, (err, reply) => {
            client.get('counter', (err, counter) => {
                    resolve({'ok': counter});
            });
        })
    });
    
    client.on('error', (err) => {
        console.log('client error');
        console.log(err);
    });

});
