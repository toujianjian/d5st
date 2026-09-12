#!/bin/bash
set -e

echo "正在初始化 D5ST 数据库..."

mysql -u root -p"${MYSQL_ROOT_PASSWORD}" <<EOSQL
CREATE DATABASE IF NOT EXISTS casdoor DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
EOSQL

echo "Casdoor 数据库已准备就绪"
echo "D5ST 数据库初始化完成"
