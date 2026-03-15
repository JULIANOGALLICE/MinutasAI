import http from 'http';

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Login:', data);
    const cookie = res.headers['set-cookie']?.[0];
    
    if (!cookie) {
      console.log('No cookie received');
      return;
    }

    const req2 = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/users',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      }
    }, (res2) => {
      let data2 = '';
      res2.on('data', chunk => data2 += chunk);
      res2.on('end', () => console.log('Create User:', data2));
    });
    req2.write(JSON.stringify({ username: 'testuser2', password: 'password', role: 'comum' }));
    req2.end();
  });
});
req.write(JSON.stringify({ username: 'adm', password: 'adm' }));
req.end();
