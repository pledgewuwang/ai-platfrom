/**
 * AI Platform 自定义 Node 服务器
 *
 * 为什么需要自定义 server:
 *  - 项目为直连部署(next dev -H 内网IP,无反向代理),middleware 中
 *    x-forwarded-for 等头为空时拿不到真实客户端 IP,LAN 鉴权会失效。
 *  - 这里在每个请求交给 Next 之前,用 socket 真实远端地址覆盖
 *    x-forwarded-for / x-real-ip:
 *      * 真实 IP 可靠(Tailscale 用户是 100.x / fd7a:…,局域网用户是 RFC1918,
 *        localhost 是 127.0.0.1 / ::1)
 *      * 客户端伪造的转发头被覆盖,顺带消除 XFF 伪造绕过(middleware 里
 *        不要再信任任何外部传入的转发头)
 *
 * 部署:LAN_AUTH_PASSWORD 配置后,私网(非 Tailscale/非 localhost)访问
 * 需在 /lan-login 输入密码;Tailscale 访问全程放行,不受影响。
 */
const http = require("http");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3001", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

/** 取真实客户端 IP:strip IPv6-mapped IPv4 前缀(::ffff:192.168.1.5 → 192.168.1.5) */
function realClientIp(req) {
  const raw = req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    // 覆盖可伪造的转发头为真实 socket IP(直连部署;有反代时反代应改配
    // trusted proxy,把反代地址排除 —— 本项目直接暴露,无需此步)
    const ip = realClientIp(req);
    req.headers["x-forwarded-for"] = ip;
    req.headers["x-real-ip"] = ip;
    handle(req, res);
  });

  server.listen(port, hostname, () => {
    console.log(
      "> AI Platform 已启动: http://" + hostname + ":" + port + " (" + (dev ? "dev" : "prod") + ")" +
        (process.env.LAN_AUTH_PASSWORD ? " · LAN 鉴权已启用" : " · LAN 鉴权未启用")
    );
  });
});
