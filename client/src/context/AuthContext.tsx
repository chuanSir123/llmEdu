import { createContext, useContext, useMemo, useState } from "react";
import { clearAuth, getStoredUser, saveAuth, type LoginResult } from "../api/GatewayClient";

type AuthContextValue = {
  user: LoginResult["user"] | null;
  setLogin: (result: LoginResult) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<LoginResult["user"] | null>(() => getStoredUser());
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      setLogin(result) {
        saveAuth(result);
        setUser(result.user);
      },
      logout() {
        clearAuth();
        setUser(null);
      }
    }),
    [user]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider missing");
  return value;
}
