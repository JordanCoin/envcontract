export const apiConfig = {
  secret: process.env.API_SECRET!,
  database: new URL(process.env.DATABASE_URL).href,
};
