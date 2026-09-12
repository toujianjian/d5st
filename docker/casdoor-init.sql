-- Casdoor 所需的基础数据库预创建
-- Casdoor 启动时会自动创建自身表结构（--createDatabase=true）

CREATE DATABASE IF NOT EXISTS casdoor DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 关键：把 casdoor 库也授权给 d5st 用户（否则 Casdoor 连不上）
GRANT ALL PRIVILEGES ON casdoor.* TO 'd5st'@'%';
FLUSH PRIVILEGES;
