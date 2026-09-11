module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^react-native$": "<rootDir>/tests/mocks/react-native.js",
    "^expo-sqlite$": "<rootDir>/tests/mocks/expo-sqlite.js",
    "^expo-secure-store$": "<rootDir>/tests/mocks/expo-secure-store.js",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          jsx: "react-jsx",
          esModuleInterop: true,
        },
      },
    ],
  },
};
