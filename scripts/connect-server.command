#!/bin/zsh
set -eu

print 'Подключение к серверу MacBookBro. Для выхода введи exit.'
exec /usr/bin/ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 macbookbro
