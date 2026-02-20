module.exports = {
  apps: [
    {
      name: 'whatsapp-boukir',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      kill_timeout: 20000,
      max_restarts: 50,
      min_uptime: '15s',
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        HOST: process.env.HOST || '0.0.0.0',
        PORT: process.env.PORT || '3600',
        WA_API_KEY: process.env.WA_API_KEY || 'Q9Kx6Q2f5pQAU1uYIY0YyWJp2Zb7e1w60H8rFf3yERZ3',
        DEFAULT_CC: process.env.DEFAULT_CC || '212',
        CHROME_PATH: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        WWEBJS_AUTH_DIR: '/var/lib/whatsapp-auth/boukir',
  WWEBJS_CLIENT_ID: 'boukir-prod',
        API_BASE: process.env.API_BASE || 'http://127.0.0.1',
        TEMPLATE_API_KEY: process.env.TEMPLATE_API_KEY || ''
      }
    }
  ]
};
