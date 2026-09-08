const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

function getDbConfig(){
  const urlValue = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if(urlValue){
    const u = new URL(urlValue);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, ''))
    };
  }
  return {
    host: process.env.DB_HOST || process.env.MYSQLHOST || 'localhost',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || 'samyak',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'expense_tracker'
  };
}

const dbConfig = getDbConfig();

const sessionStore = new MySQLStore({
  ...dbConfig,
  createDatabaseTable: true,
  clearExpired: true,
  expiration: 1000 * 60 * 60 * 24 * 30,
  checkExpirationInterval: 1000 * 60 * 60
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-my-money-secret',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 30 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  ...dbConfig, waitForConnections: true, connectionLimit: 5, dateStrings: true
});


async function initDb(){
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id INT PRIMARY KEY AUTO_INCREMENT,name VARCHAR(100) NOT NULL,email VARCHAR(190) NOT NULL UNIQUE,password_hash VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS expenses (id INT PRIMARY KEY AUTO_INCREMENT,user_id INT NULL,amount DECIMAL(10,2) NOT NULL,category VARCHAR(50) NOT NULL,description VARCHAR(255),payment_method VARCHAR(30) NOT NULL,expense_date DATE NOT NULL,expense_time TIME NOT NULL,INDEX idx_expenses_user_date (user_id, expense_date))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (id INT PRIMARY KEY AUTO_INCREMENT,user_id INT NULL UNIQUE,monthly_income DECIMAL(10,2) NOT NULL DEFAULT 0,savings_target DECIMAL(10,2) NOT NULL DEFAULT 0)`);
  const [ec]=await pool.query(`SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='expenses' AND COLUMN_NAME='user_id'`);
  if(!Number(ec[0].c)) await pool.query(`ALTER TABLE expenses ADD COLUMN user_id INT NULL, ADD INDEX idx_expenses_user_date (user_id, expense_date)`);
  const [sc]=await pool.query(`SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND COLUMN_NAME='user_id'`);
  if(!Number(sc[0].c)) await pool.query(`ALTER TABLE settings ADD COLUMN user_id INT NULL, ADD UNIQUE INDEX uq_settings_user (user_id)`);
  const [sa]=await pool.query(`SELECT EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND COLUMN_NAME='id' LIMIT 1`);
  if(sa.length && !String(sa[0].EXTRA || '').toLowerCase().includes('auto_increment')) await pool.query(`ALTER TABLE settings MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT`);
  await pool.query(`INSERT INTO users (id,name,email,password_hash) SELECT 1,'My Money User','change-me@example.com','' WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=1)`);
  await pool.query(`UPDATE expenses SET user_id=1 WHERE user_id IS NULL`);
  await pool.query(`UPDATE settings SET user_id=1 WHERE user_id IS NULL`);
  const [fk]=await pool.query(`SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='expenses' AND COLUMN_NAME='user_id' AND REFERENCED_TABLE_NAME='users'`);
  if(!Number(fk[0].c)) await pool.query(`ALTER TABLE expenses ADD CONSTRAINT fk_expenses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
  const [sfk]=await pool.query(`SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND COLUMN_NAME='user_id' AND REFERENCED_TABLE_NAME='users'`);
  if(!Number(sfk[0].c)) await pool.query(`ALTER TABLE settings ADD CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
}

function auth(req,res,next){ if(!req.session.userId) return res.status(401).json({error:'Please log in.'}); next(); }
async function settingsFor(userId){
  const [rows]=await pool.query('SELECT monthly_income, savings_target FROM settings WHERE user_id=? LIMIT 1',[userId]);
  return rows[0] || {monthly_income:0,savings_target:0};
}

app.get('/api/health', async (req,res)=>{ try{await pool.query('SELECT 1');res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:e.message});} });

app.get('/api/me',(req,res)=>res.json({loggedIn:!!req.session.userId,user:req.session.userId?{id:req.session.userId,name:req.session.name,email:req.session.email}:null}));

app.post('/api/register',async(req,res)=>{
  try{
    const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
    if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||password.length<6) return res.status(400).json({error:'Enter a name, valid email and password of at least 6 characters.'});
    const [exists]=await pool.query('SELECT id FROM users WHERE email=? LIMIT 1',[email]); if(exists.length) return res.status(409).json({error:'An account with this email already exists.'});
    const hash=await bcrypt.hash(password,12);
    let userId;
    const [placeholder]=await pool.query("SELECT id FROM users WHERE id=1 AND email='change-me@example.com' AND password_hash='' LIMIT 1");
    if(placeholder.length){
      userId=1; await pool.query('UPDATE users SET name=?,email=?,password_hash=? WHERE id=1',[name,email,hash]);
    } else {
      const [r]=await pool.query('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)',[name,email,hash]); userId=r.insertId;
      await pool.query('INSERT INTO settings (user_id,monthly_income,savings_target) VALUES (?,?,?)',[userId,0,0]);
    }
    req.session.userId=userId; req.session.name=name; req.session.email=email;
    res.status(201).json({user:{id:userId,name,email}});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/login',async(req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
    const [rows]=await pool.query('SELECT id,name,email,password_hash FROM users WHERE email=? LIMIT 1',[email]);
    if(!rows.length || !(await bcrypt.compare(password,rows[0].password_hash))) return res.status(401).json({error:'Incorrect email or password.'});
    req.session.userId=rows[0].id;req.session.name=rows[0].name;req.session.email=rows[0].email;
    res.json({user:{id:rows[0].id,name:rows[0].name,email:rows[0].email}});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get('/api/settings',auth,async(req,res)=>{try{res.json(await settingsFor(req.session.userId));}catch(e){res.status(500).json({error:e.message});}});
app.put('/api/settings',auth,async(req,res)=>{
  try{const income=Number(req.body.monthly_income),savings=Number(req.body.savings_target);if(!Number.isFinite(income)||income<0||!Number.isFinite(savings)||savings<0)return res.status(400).json({error:'Enter valid non-negative amounts.'});await pool.query('INSERT INTO settings (user_id,monthly_income,savings_target) VALUES (?,?,?) ON DUPLICATE KEY UPDATE monthly_income=VALUES(monthly_income), savings_target=VALUES(savings_target)',[req.session.userId,income,savings]);res.json(await settingsFor(req.session.userId));}catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/dashboard',auth,async(req,res)=>{
  try{const uid=req.session.userId,settings=await settingsFor(uid);const [today]=await pool.query('SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE user_id=? AND expense_date=CURDATE()',[uid]);const [month]=await pool.query('SELECT COALESCE(SUM(amount),0) total, COUNT(*) count FROM expenses WHERE user_id=? AND YEAR(expense_date)=YEAR(CURDATE()) AND MONTH(expense_date)=MONTH(CURDATE())',[uid]);const budget=Number(settings.monthly_income)-Number(settings.savings_target),spent=Number(month[0].total),remaining=budget-spent;const daysInMonth=new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate(),day=new Date().getDate(),safe=remaining>0?remaining/Math.max(1,daysInMonth-day+1):0;const [recent]=await pool.query('SELECT id,amount,category,description,payment_method,expense_date,expense_time FROM expenses WHERE user_id=? ORDER BY expense_date DESC,expense_time DESC,id DESC LIMIT 5',[uid]);res.json({today:Number(today[0].total),monthly:spent,count:Number(month[0].count),budget,remaining,safe,recent,income:Number(settings.monthly_income),savings:Number(settings.savings_target)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/expenses',auth,async(req,res)=>{try{const uid=req.session.userId,q=String(req.query.q||'').trim(),category=String(req.query.category||'').trim(),params=[uid],where=['user_id=?'];if(q){where.push('(description LIKE ? OR category LIKE ? OR payment_method LIKE ?)');params.push(`%${q}%`,`%${q}%`,`%${q}%`);}if(category&&category!=='All'){where.push('category=?');params.push(category);}const [rows]=await pool.query(`SELECT id,amount,category,description,payment_method,expense_date,expense_time FROM expenses WHERE ${where.join(' AND ')} ORDER BY expense_date DESC,expense_time DESC,id DESC LIMIT 300`,params);res.json(rows);}catch(e){res.status(500).json({error:e.message});}});

app.post('/api/expenses',auth,async(req,res)=>{try{const amount=Number(req.body.amount),category=String(req.body.category||''),description=String(req.body.description||''),payment=String(req.body.payment_method||''),date=String(req.body.expense_date||'').trim();if(!Number.isFinite(amount)||amount<=0||!category||!payment)return res.status(400).json({error:'Amount, category and payment method are required.'});const expenseDate=/^\d{4}-\d{2}-\d{2}$/.test(date)?date:new Date().toISOString().slice(0,10),time=new Date().toTimeString().slice(0,8);const [r]=await pool.query('INSERT INTO expenses (user_id,amount,category,description,payment_method,expense_date,expense_time) VALUES (?,?,?,?,?,?,?)',[req.session.userId,amount,category,description,payment,expenseDate,time]);res.status(201).json({id:r.insertId});}catch(e){res.status(500).json({error:e.message});}});

app.put('/api/expenses/:id',auth,async(req,res)=>{try{const amount=Number(req.body.amount),category=String(req.body.category||''),description=String(req.body.description||''),payment=String(req.body.payment_method||''),date=String(req.body.expense_date||'');if(!Number.isFinite(amount)||amount<=0||!category||!payment||!/^(\d{4})-(\d{2})-(\d{2})$/.test(date))return res.status(400).json({error:'Enter valid expense details.'});await pool.query('UPDATE expenses SET amount=?,category=?,description=?,payment_method=?,expense_date=? WHERE id=? AND user_id=?',[amount,category,description,payment,date,req.params.id,req.session.userId]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});
app.delete('/api/expenses/:id',auth,async(req,res)=>{try{await pool.query('DELETE FROM expenses WHERE id=? AND user_id=?',[req.params.id,req.session.userId]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message});}});

app.get('/api/analytics',auth,async(req,res)=>{try{const uid=req.session.userId,settings=await settingsFor(uid);const [summary]=await pool.query('SELECT COALESCE(SUM(amount),0) total,COALESCE(AVG(amount),0) avg,COUNT(*) count FROM expenses WHERE user_id=? AND YEAR(expense_date)=YEAR(CURDATE()) AND MONTH(expense_date)=MONTH(CURDATE())',[uid]);const [cats]=await pool.query('SELECT category,SUM(amount) total FROM expenses WHERE user_id=? AND YEAR(expense_date)=YEAR(CURDATE()) AND MONTH(expense_date)=MONTH(CURDATE()) GROUP BY category ORDER BY total DESC',[uid]);const [days]=await pool.query('SELECT expense_date,SUM(amount) total FROM expenses WHERE user_id=? AND expense_date>=CURDATE()-INTERVAL 6 DAY GROUP BY expense_date ORDER BY expense_date',[uid]);const map=Object.fromEntries(days.map(x=>[String(x.expense_date),Number(x.total)])),daily=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);daily.push({date:d.toISOString().slice(0,10),total:map[d.toISOString().slice(0,10)]||0});}const budget=Number(settings.monthly_income)-Number(settings.savings_target),total=Number(summary[0].total);res.json({total,avg:Number(summary[0].avg),count:Number(summary[0].count),budget,budgetPercent:budget>0?total/budget*100:0,topCategory:cats[0]?.category||'None',categories:cats.map(x=>({category:x.category,total:Number(x.total)})),daily});}catch(e){res.status(500).json({error:e.message});}});

app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const PORT=Number(process.env.PORT||3000);

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`My Money running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Database initialization failed:', e);
    process.exit(1);
  });
