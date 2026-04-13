FROM eclipse-temurin:21-jre-alpine

WORKDIR /app
COPY build/libs/webrtc-0.0.1-SNAPSHOT.jar app.jar

EXPOSE 8085

ENV SPRING_PROFILES_ACTIVE=docker
ENTRYPOINT ["java", "-Xmx512m", "-jar", "app.jar"]
