# homegames.link
homegames.link

![homegames.link diagram](https://d3lgoy70hwd3pc.cloudfront.net/homegames_link.png)

### General idea:
- A Homegames instance maintains a separate optional WS connection to homegames.link. 
- The Homegames instance tells homegames.link its local IP address. 
- homegames.link keeps that local IP in an in-memory cache, using the public IP of the Homegames instance as a key
- When a browser requests http://homegames.link, homegames.link will check the cache to see if there's a key for the requester's public IP
- If there is, redirect the client to the homegames instance's local network IP address
- If not, display "none". 

### Notes
- Might not need to use WS
- Should probably use "none" as an opportunity to market Homegames, like "no local servers found but make one it's rad and easy" or something.
- Browser caching makes life difficult
