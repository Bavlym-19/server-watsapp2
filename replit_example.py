import requests
import time

# استبدل هذا الرابط برابط السيرفر الخاص بك (Render أو Replit أو غيره)
SERVER_URL = "https://your-app-name.onrender.com"

def send_whatsapp_message(session_id, number, message):
    """
    إرسال رسالة واتساب واحدة
    """
    url = f"{SERVER_URL}/send-message"
    payload = {
        "sessionId": session_id,
        "number": number,
        "message": message
    }
    try:
        response = requests.post(url, json=payload)
        if response.status_code == 200:
            print(f"✅ تم إرسال الرسالة بنجاح للرقم {number}")
            return response.json()
        else:
            print(f"❌ فشل الإرسال للرقم {number}: {response.text}")
            return None
    except Exception as e:
        print(f"⚠️ خطأ في الاتصال بالسيرفر: {e}")
        return None

def send_whatsapp_campaign(session_id, numbers, message, delay=5000):
    """
    إرسال حملة واتساب لعدة أرقام دفعة واحدة
    :param numbers: قائمة بالأرقام (List)
    :param delay: الفاصل الزمني بالميلي ثانية (5000 = 5 ثواني)
    """
    url = f"{SERVER_URL}/send-campaign"
    payload = {
        "sessionId": session_id,
        "numbers": numbers,
        "message": message,
        "delay": delay
    }
    try:
        response = requests.post(url, json=payload)
        if response.status_code == 200:
            print(f"🚀 تم بدء الحملة بنجاح! سيقوم السيرفر بالإرسال لـ {len(numbers)} رقم.")
            return response.json()
        else:
            print(f"❌ فشل بدء الحملة: {response.text}")
            return None
    except Exception as e:
        print(f"⚠️ خطأ في الاتصال بالسيرفر: {e}")
        return None

if __name__ == "__main__":
    print("--- نظام إرسال واتساب المطور ---")
    print("1. إرسال رسالة واحدة")
    print("2. إرسال حملة (عدة أرقام)")
    
    choice = input("اختر (1 أو 2): ")
    session_id = input("أدخل معرف الجلسة (session1, session2, session3): ")
    msg = input("أدخل الرسالة: ")

    if choice == "1":
        phone = input("أدخل رقم الهاتف (بمفتاح الدولة): ")
        send_whatsapp_message(session_id, phone, msg)
    elif choice == "2":
        phones_raw = input("أدخل الأرقام مفصولة بفاصلة (مثال: 201234567890,201098765432): ")
        phones_list = [p.strip() for p in phones_raw.split(",")]
        delay_sec = input("أدخل الفاصل الزمني بالثواني (افتراضي 5): ")
        delay_ms = int(delay_sec) * 1000 if delay_sec else 5000
        send_whatsapp_campaign(session_id, phones_list, msg, delay_ms)
    else:
        print("خيار غير صحيح.")
