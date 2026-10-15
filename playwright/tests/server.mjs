/* 本地静态服务：fixture 用 http 提供，srcdoc iframe 才和父页面同源 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function startFixtureServer() {
    const file = resolve(import.meta.dirname, 'fixtures/course.html');
    const html = await readFile(file);
    const server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/course.html`,
        async close() {
            /* 浏览器会保持 keep-alive 连接，不先掐断的话 server.close() 会一直等下去 */
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((done) => server.close(done));
        },
    };
}
