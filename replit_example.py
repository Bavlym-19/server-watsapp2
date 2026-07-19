import requests

# استبدل هذا الرابط برابط السيرفر الخاص بك على Render بعد الرفع
RENDER_SERVER_URL = "https://your-app-name.onrender.com"

def send_whatsapp_message(session_id, number, message):
    """
    إرسال رسالة واتساب عبر سيرفر Render لجلسة محددة
    :param session_id: معرف الجلسة (مثال: 'session1', 'session2', 'session3')
    :param number: رقم الهاتف مع مفتاح الدولة (مثال: 201234567890)
    :param message: نص الرسالة
    """
    url = f"{RENDER_SERVER_URL}/send-message"
    payload = {
        "sessionId": session_id,
        "number": number,
        "message": message
    }
    try:
        response = requests.post(url, json=payload)
        if response.status_code == 200:
            print(f"✅ تم إرسال الرسالة بنجاح للجلسة {session_id}")
            return response.json()
        else:
            print(f"❌ فشل الإرسال للجلسة {session_id}: {response.text}")
            return None
    except Exception as e:
        print(f"⚠️ خطأ في الاتصال بالسيرفر للجلسة {session_id}: {e}")
        return None

if __name__ == "__main__":
    # مثال للاستخدام في ريبليت
    session_id = input("أدخل معرف الجلسة (session1, session2, session3): ")
    phone = input("أدخل رقم الهاتف (بمفتاح الدولة): ")
    msg = input("أدخل الرسالة: ")
    send_whatsapp_message(session_id, phone, msg)
