const http = require('http');
const fs = require('fs');

http.createServer((req, res) => fs.createReadStream('app-1.html').pipe(res)).listen(3012);