import tkinter as tk
from tkinter import messagebox
import sqlite3
import os

class ShortPhraseFixerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Обработка коротких фраз")
        self.root.geometry("500x200")

        # Путь к базе данных
        self.db_path = r"C:\Users\user\Documents\promti2\promti2.db"
        
        # --- Элементы интерфейса ---
        
        # Описание задачи
        lbl_info = tk.Label(
            root, 
            text="Программа найдет фразы короче 3 символов в таблице 'phrases',\nпреобразует первую букву в нижний регистр и добавит\nзапись в таблицу 'forbidden_words'.",
            justify=tk.CENTER,
            padx=10, pady=10
        )
        lbl_info.pack(pady=10)

        # Кнопка запуска
        self.btn_start = tk.Button(
            root, 
            text="Запустить обработку", 
            command=self.process_short_phrases,
            height=2,
            bg="#dddddd"
        )
        self.btn_start.pack(pady=20, padx=20, fill=tk.X)

    def process_short_phrases(self):
        """Основной алгоритм обработки коротких фраз"""
        
        # Проверка наличия файла базы данных
        if not os.path.exists(self.db_path):
            messagebox.showerror("Ошибка", f"База данных не найдена по пути:\n{self.db_path}")
            return

        try:
            # Подключение к БД
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()

            # 1. Находим фразы, длина которых меньше 3 символов
            # LENGTH в SQLite считает количество символов
            cursor.execute("SELECT id, phrase FROM phrases WHERE LENGTH(phrase) < 3")
            short_phrases = cursor.fetchall()

            if not short_phrases:
                messagebox.showinfo("Результат", "Фраз короче 3 символов не найдено.")
                conn.close()
                return

            inserted_count = 0
            
            # 2. Обрабатываем каждую найденную фразу
            for row in short_phrases:
                phrase_id = row[0]
                phrase_text = row[1]

                # Пропускаем пустые строки, если вдруг такие есть
                if not phrase_text:
                    continue

                # "Изменить первую букву на такую же в нижнем регистре"
                # phrase_text[0].lower() - первая буква в нижнем регистре
                # phrase_text[1:] - остаток строки (если есть)
                modified_text = phrase_text[0].lower() + phrase_text[1:]

                # 3. Записать результат в таблицу "forbidden_words"
                # Используем INSERT OR IGNORE, чтобы избежать ошибок дублирования,
                # если для этой фразы уже есть такая запись
                try:
                    cursor.execute(
                        "INSERT INTO forbidden_words (phrase_id, root) VALUES (?, ?)",
                        (phrase_id, modified_text)
                    )
                    inserted_count += 1
                except sqlite3.IntegrityError:
                    # Если запись уже существует, игнорируем ошибку
                    pass

            # Сохраняем изменения
            conn.commit()
            conn.close()

            messagebox.showinfo(
                "Готово", 
                f"Обработка завершена.\n"
                f"Найдено коротких фраз: {len(short_phrases)}\n"
                f"Добавлено записей в forbidden_words: {inserted_count}"
            )

        except sqlite3.Error as e:
            messagebox.showerror("Ошибка БД", f"Произошла ошибка при работе с базой данных:\n{e}")
        except Exception as e:
            messagebox.showerror("Ошибка", f"Произошла непредвиденная ошибка:\n{e}")

if __name__ == "__main__":
    root = tk.Tk()
    app = ShortPhraseFixerApp(root)
    root.mainloop()