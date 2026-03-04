#!/bin/bash
# Deploy script for Kharina Bot (Hybrid Python + Node.js)
# Run on VPS: ./deploy.sh [production|staging]

set -e

ENV=${1:-production}
STACK_NAME="kharina-bot"
VPS_IP="72.60.137.167"

echo "🚀 Deploying Kharina Bot to $ENV environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running on VPS
if [ "$ENV" == "production" ] && [ "$(hostname -I | awk '{print $1}')" != "$VPS_IP" ]; then
    echo -e "${YELLOW}⚠️  Not on VPS. Deploying via SSH...${NC}"
    ssh -o StrictHostKeyChecking=no root@$VPS_IP 'cd /opt/kharina-bot && git pull && ./deploy.sh production'
    exit 0
fi

# Update code
echo -e "${YELLOW}📥 Updating code from Git...${NC}"
git pull origin main

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Build Python LangChain image
echo -e "${YELLOW}🐍 Building Python LangChain image...${NC}"
docker build -t kharina-langchain:latest ./python-langchain/

# Build Node.js Backend image
echo -e "${YELLOW}🟢 Building Node.js Backend image...${NC}"
cd nodejs-bot/backend
docker build -t kharina-backend:latest .
cd ../..

# Deploy to Swarm
echo -e "${YELLOW}🐳 Deploying to Docker Swarm...${NC}"
docker stack deploy -c docker-compose.swarm.yml $STACK_NAME --with-registry-auth

# Wait for services
echo -e "${YELLOW}⏳ Waiting for services to start...${NC}"
sleep 10

# Health check
echo -e "${YELLOW}🏥 Health check...${NC}"
if curl -sf http://localhost:8000/health > /dev/null; then
    echo -e "${GREEN}✅ LangChain service is healthy${NC}"
else
    echo -e "${RED}❌ LangChain service health check failed${NC}"
    docker service logs ${STACK_NAME}_langchain --tail 50
    exit 1
fi

if curl -sf http://localhost:3000/health > /dev/null; then
    echo -e "${GREEN}✅ Backend service is healthy${NC}"
else
    echo -e "${RED}❌ Backend service health check failed${NC}"
    docker service logs ${STACK_NAME}_backend --tail 50
    exit 1
fi

# Clean up old images
echo -e "${YELLOW}🧹 Cleaning up old images...${NC}"
docker image prune -f --filter "until=24h"

echo -e "${GREEN}✅ Deploy completed successfully!${NC}"
echo ""
echo "📊 Status:"
docker stack ps $STACK_NAME --format "table {{.Name}}\t{{.CurrentState}}\t{{.Error}}"
echo ""
echo "📜 Logs:"
echo "  LangChain: docker service logs -f ${STACK_NAME}_langchain"
echo "  Backend:   docker service logs -f ${STACK_NAME}_backend"
