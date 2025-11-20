module.exports = {
  apps: [
    {
      name: 'whatsapp',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '15s',
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        HOST: process.env.HOST || '0.0.0.0',
        PORT: process.env.PORT || '3400',
        WA_API_KEY: process.env.WA_API_KEY || 'Q9Kx6Q2f5pQAU1uYIY0YyWJp2Zb7e1w60H8rFf3yERZ3',
        DEFAULT_CC: process.env.DEFAULT_CC || '212',
        CHROME_PATH: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        WWEBJS_AUTH_DIR: process.env.WWEBJS_AUTH_DIR || '/var/lib/whatsapp-auth',
        WWEBJS_CLIENT_ID: process.env.WWEBJS_CLIENT_ID || 'sirh-prod',
        API_BASE: process.env.API_BASE || 'http://127.0.0.1',
        TEMPLATE_API_KEY: process.env.TEMPLATE_API_KEY || ''
      }
    }
  ]
};
