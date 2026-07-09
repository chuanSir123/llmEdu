import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { LayoutRenderer } from "../renderers/LayoutRenderer";
import { LandingPage } from "../renderers/LandingPage";
import { LoginPage } from "../renderers/PublicPageLoader";
import { WechatPortalPage } from "../renderers/WechatPortalPage";

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage kind="tenant" />} />
        <Route path="/admin" element={<LoginPage kind="admin" />} />
        <Route path="/admin/app" element={<LayoutRenderer scope="admin" />} />
        <Route path="/:schemaName/wx" element={<WechatPortalPage />} />
        <Route path="/:schemaName/wx/home" element={<WechatPortalPage />} />
        <Route path="/:schemaName/wx/mall" element={<WechatPortalPage />} />
        <Route path="/:schemaName/wx/me" element={<WechatPortalPage />} />
        <Route path="/:schemaName" element={<LoginPage kind="tenant" />} />
        <Route path="/:schemaName/app" element={<LayoutRenderer scope="tenant" />} />
        <Route path="/:schemaName/app/page/:pageCode" element={<LayoutRenderer scope="tenant" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
