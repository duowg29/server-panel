"""Trang Admin của server-panel — quản lý dữ liệu TinyTalk trên Supabase.

Thay hẳn ứng dụng `tinytalk-admin` (React). Khác biệt chính về bảo mật:
khoá `service_role` chỉ nằm ở backend này (đọc từ `.env.admin`), trình duyệt
không bao giờ nhận được; panel chỉ mở ở 127.0.0.1.
"""
