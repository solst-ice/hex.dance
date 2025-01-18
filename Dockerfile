FROM node:lts-jod

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 5173

# Start the development server
CMD ["npm", "run", "docker", "--host"]

