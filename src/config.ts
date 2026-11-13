function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '4600')),
  publicUrl: env('PUBLIC_URL', 'https://titan.kitovu.com.ng'),
  databaseUrl: env('DATABASE_URL', 'postgres://titan@localhost:5432/titan'),
  /** Shared secret EMQX sends in X-Titan-Internal when calling auth/acl/message hooks. */
  internalSecret: env('TITAN_INTERNAL_SECRET', 'change-me'),
  mqtt: {
    host: env('MQTT_PUBLIC_HOST', 'mqtt.titan.kitovu.com.ng'),
    port: Number(env('MQTT_PUBLIC_PORT', '8883')),
  },
  emqx: {
    apiUrl: env('EMQX_API_URL', 'http://127.0.0.1:18083/api/v5'),
    apiKey: env('EMQX_API_KEY', ''),
    apiSecret: env('EMQX_API_SECRET', ''),
  },
  resend: {
    apiKey: env('RESEND_API_KEY', ''),
    from: env('RESEND_FROM', 'Titan <alerts@titan.kitovu.com.ng>'),
    demoInbox: env('DEMO_INBOX', 'titan@kitovu.com.ng'),
  },
  termii: {
    apiKey: env('TERMII_API_KEY', ''),
    senderId: env('TERMII_SENDER_ID', 'Titan'),
    baseUrl: env('TERMII_BASE_URL', 'https://v3.api.termii.com'),
  },
  paystack: {
    secretKey: env('PAYSTACK_SECRET_KEY', ''),
  },
  offlineSweepSeconds: Number(env('OFFLINE_SWEEP_SECONDS', '30')),
};

export type Config = typeof config;
