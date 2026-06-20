import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LayoutRenderer } from "../renderers/LayoutRenderer";
import { LoginPage, TenantSelectPage } from "../renderers/PublicPageLoader";

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TenantSelectPage />} />
        <Route path="/admin" element={<LoginPage kind="admin" />} />
        <Route path="/admin/app" element={<LayoutRenderer scope="admin" />} />
        <Route path="/:schemaName" element={<LoginPage kind="tenant" />} />
        <Route path="/:schemaName/app" element={<LayoutRenderer scope="tenant" />} />
        <Route path="/:schemaName/app/page/:pageCode" element={<LayoutRenderer scope="tenant" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
