#!/bin/bash

# Exit on error
set -e

echo "🚀 Starting update process..."

# Pull latest changes
echo "⬇️  Pulling latest changes from repository..."
git pull

# Install/update npm dependencies
echo "📦 Installing npm dependencies..."
npm install

# Reload PM2 application
echo "🔄 Reloading application..."
pm2 reload cloudpanel-api

echo "✅ Update completed successfully!"
#