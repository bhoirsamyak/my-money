# My Money — Online Deployment Edition

My Money is a mobile-first personal expense tracker with login, per-user expenses, analytics, savings tracking and PWA support.

## Recommended deployment
Railway + MySQL 8.

The server supports environment variables for production:
- DB_HOST
- DB_PORT
- DB_USER
- DB_PASSWORD
- DB_NAME
- SESSION_SECRET
- NODE_ENV=production

The app uses a MySQL-backed session store so login sessions survive normal server restarts.

## Local run
npm install
npm start

## Railway
Create a Railway project, add a MySQL service, then deploy this app. Set the database variables from the MySQL service and set a strong SESSION_SECRET. Generate a public domain for the app service.

Do not use the local root password in production. Create a dedicated database user with only the privileges needed by this app.
