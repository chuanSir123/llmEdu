import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { clearAuth, getStoredUser, getStoredPermissions, saveAuth, type LoginResult } from "../api/GatewayClient";
import { GatewayClient } from "../api/GatewayClient";

type Permissions = LoginResult["permissions"];

type AuthContextValue = {
  user: LoginResult["user"] | null;
  permissions: Permissions;
  setLogin: (result: LoginResult) => void;
  logout: () => void;
  refreshPermissions: () => Promise<void>;
  hasPagePermission: (pageCode: string) => boolean;
  hasButtonPermission: (actionCode: string) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<LoginResult["user"] | null>(() => getStoredUser());
  const [permissions, setPermissions] = useState<Permissions>(() => getStoredPermissions() ?? undefined);

  const refreshPermissions = useCallback(async () => {
    try {
      const perms = await GatewayClient.getPermissions();
      setPermissions(perms ?? undefined);
      if (perms) localStorage.setItem("llmedu_permissions", JSON.stringify(perms));
    } catch { /* ignore */ }
  }, []);

  const hasPagePermission = useCallback((pageCode: string) => {
    if (!permissions) return true;
    if (permissions.pages.includes("*")) return true;
    return permissions.pages.includes(pageCode);
  }, [permissions]);

  const hasButtonPermission = useCallback((actionCode: string) => {
    if (!permissions) return true;
    if (permissions.buttons.includes("*")) return true;
    return permissions.buttons.some((b) => b.endsWith(`:${actionCode}`) || b === actionCode);
  }, [permissions]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      permissions,
      setLogin(result) {
        saveAuth(result);
        setUser(result.user);
        setPermissions(result.permissions ?? undefined);
      },
      logout() {
        GatewayClient.logout().catch(() => {});
        clearAuth();
        setUser(null);
        setPermissions(undefined);
      },
      refreshPermissions,
      hasPagePermission,
      hasButtonPermission,
    }),
    [user, permissions, refreshPermissions, hasPagePermission, hasButtonPermission]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider missing");
  return value;
}
