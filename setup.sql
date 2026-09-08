CREATE DATABASE IF NOT EXISTS expense_tracker;
USE expense_tracker;

CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    amount DECIMAL(10,2) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description VARCHAR(255),
    payment_method VARCHAR(30) NOT NULL,
    expense_date DATE NOT NULL,
    expense_time TIME NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NULL,
    monthly_income DECIMAL(10,2) NOT NULL DEFAULT 0,
    savings_target DECIMAL(10,2) NOT NULL DEFAULT 0
);

-- The Node server also performs safe migration checks automatically on startup.
-- Existing expenses/settings are assigned to the first account created.
