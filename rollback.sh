#!/bin/bash
# Rollback script for Kharina Bot

STACK_NAME="kharina-bot"

echo "🔄 Rolling back Kharina Bot..."

# Get previous image versions
PREV_LANGCHAIN=$(docker images kharina-langchain --format "{{.Repository}}:{{.Tag}}" | grep -v latest | head -1)
PREV_BACKEND=$(docker images kharina-backend --format "{{.Repository}}:{{.Tag}}" | grep -v latest | head -1)

if [ -z "$PREV_LANGCHAIN" ] || [ -z "$PREV_BACKEND" ]; then
    echo "❌ No previous versions found for rollback"
    exit 1
fi

echo "Rolling back to:"
echo "  LangChain: $PREV_LANGCHAIN"
echo "  Backend: $PREV_BACKEND"

# Update services with previous images
docker service update --image $PREV_LANGCHAIN ${STACK_NAME}_langchain
docker service update --image $PREV_BACKEND ${STACK_NAME}_backend

echo "✅ Rollback completed"
