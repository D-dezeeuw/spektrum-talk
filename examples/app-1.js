const http = require('http');
const fs = require('fs');

http.createServer((req, res) => fs.createReadStream('index.html').pipe(res)).listen(3012);