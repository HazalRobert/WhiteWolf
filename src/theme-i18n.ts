import { languages } from './i18n';
import type { Language } from './types';

// Every row follows the existing language order: zh-CN, en, fr, es, ru, de, pt, ja, ko, ar.
type TranslationRow = readonly [string, string, string, string, string, string, string, string, string, string];
const catalog = {
  appearance: ['外观', 'Appearance', 'Apparence', 'Apariencia', 'Оформление', 'Darstellung', 'Aparência', '外観', '모양', 'المظهر'],
  brandDescriptor: ['X 关注关系管理', 'X follow management', 'Gestion des abonnements X', 'Gestión de seguidos en X', 'Управление подписками в X', 'X-Folgebeziehungen verwalten', 'Gestão de contas seguidas no X', 'X のフォロー管理', 'X 팔로우 관리', 'إدارة المتابعات على X'],
  themeIntro: ['选择简洁、白狼或自定义背景。', 'Choose a minimal, white wolf, or custom background.', 'Choisissez un fond épuré, avec un loup blanc ou personnalisé.', 'Elige un fondo minimalista, de lobo blanco o personalizado.', 'Выберите минималистичный фон, белого волка или своё изображение.', 'Wähle einen schlichten Hintergrund, den weißen Wolf oder ein eigenes Bild.', 'Escolha um fundo minimalista, de lobo branco ou personalizado.', 'シンプル、白狼、カスタムから背景を選べます。', '미니멀, 흰 늑대 또는 사용자 지정 배경을 선택하세요.', 'اختر خلفية بسيطة أو ذئباً أبيض أو صورة مخصّصة.'],
  minimal: ['简洁', 'Minimal', 'Épuré', 'Minimalista', 'Минимализм', 'Schlicht', 'Minimalista', 'シンプル', '미니멀', 'بسيط'],
  wolf: ['白狼', 'White wolf', 'Loup blanc', 'Lobo blanco', 'Белый волк', 'Weißer Wolf', 'Lobo branco', '白狼', '흰 늑대', 'الذئب الأبيض'],
  wolfTitle: ['白狼', 'White wolf', 'Loup blanc', 'Lobo blanco', 'Белый волк', 'Weißer Wolf', 'Lobo branco', '白狼', '흰 늑대', 'الذئب الأبيض'],
  custom: ['自定义', 'Custom', 'Personnalisé', 'Personalizado', 'Свой фон', 'Benutzerdefiniert', 'Personalizado', 'カスタム', '사용자 지정', 'مخصّص'],
  minimalDescription: ['清晰留白，专注内容', 'Open space to focus on content', 'Un fond épuré pour se concentrer sur le contenu', 'Espacio despejado para centrarte en el contenido', 'Свободное пространство и внимание к содержанию', 'Klare Flächen für den Blick aufs Wesentliche', 'Espaço livre para focar no conteúdo', '余白を活かし、コンテンツに集中', '여백으로 콘텐츠에 집중', 'مساحة هادئة للتركيز على المحتوى'],
  wolfDescription: ['雪白小狼，柔和冰蓝', 'A playful white wolf in soft ice blue', 'Un loup blanc joueur dans de doux tons bleu glacier', 'Un lobo blanco juguetón en suaves tonos azul hielo', 'Белый волчонок и мягкие ледяные оттенки голубого', 'Ein verspielter weißer Wolf in sanftem Eisblau', 'Um lobo branco brincalhão em suaves tons de azul-gelo', 'やわらかなアイスブルーと愛らしい白狼', '부드러운 아이스 블루 속 장난스러운 흰 늑대', 'ذئب أبيض مرح بدرجات زرقاء جليدية ناعمة'],
  customDescription: ['使用自己的图片作为背景', 'Use your own image as a background', 'Utilisez votre image comme arrière-plan', 'Usa tu propia imagen como fondo', 'Используйте своё изображение как фон', 'Verwende dein eigenes Bild als Hintergrund', 'Use sua própria imagem como fundo', '自分の画像を背景に設定', '내 이미지를 배경으로 사용', 'استخدم صورتك الخاصة كخلفية'],
  presets: ['预设主题', 'Presets', 'Thèmes prédéfinis', 'Temas predefinidos', 'Готовые темы', 'Vorlagen', 'Temas predefinidos', 'プリセット', '기본 테마', 'سمات جاهزة'],
  savedThemes: ['已保存主题', 'Saved themes', 'Thèmes enregistrés', 'Temas guardados', 'Сохранённые темы', 'Gespeicherte Designs', 'Temas salvos', '保存したテーマ', '저장된 테마', 'السمات المحفوظة'],
  noSavedThemes: ['还没有保存自定义主题。', 'No custom themes saved yet.', 'Aucun thème personnalisé enregistré.', 'Aún no hay temas personalizados guardados.', 'Своих сохранённых тем пока нет.', 'Noch keine eigenen Designs gespeichert.', 'Nenhum tema personalizado salvo ainda.', '保存したカスタムテーマはありません。', '저장된 사용자 지정 테마가 없습니다.', 'لم تُحفظ أي سمات مخصّصة بعد.'],
  savedCount: ['已保存 {count}/{max}', '{count}/{max} saved', '{count}/{max} enregistrés', '{count}/{max} guardados', 'Сохранено: {count}/{max}', '{count}/{max} gespeichert', '{count}/{max} salvos', '保存済み {count}/{max}', '{count}/{max}개 저장됨', 'المحفوظ: {count}/{max}'],
  newTheme: ['新建主题', 'New theme', 'Nouveau thème', 'Nuevo tema', 'Новая тема', 'Neues Design', 'Novo tema', '新しいテーマ', '새 테마', 'سمة جديدة'],
  upload: ['上传图片', 'Upload image', 'Importer une image', 'Subir imagen', 'Загрузить изображение', 'Bild hochladen', 'Enviar imagem', '画像をアップロード', '이미지 업로드', 'رفع صورة'],
  uploadHint: ['支持 {formats}，文件不超过 {max}。', 'Supports {formats}, up to {max} per file.', 'Formats : {formats}, jusqu’à {max} par fichier.', 'Formatos: {formats}, hasta {max} por archivo.', 'Форматы: {formats}. Размер файла — до {max}.', 'Formate: {formats}, bis zu {max} pro Datei.', 'Formatos: {formats}, até {max} por arquivo.', '{formats} 対応。1 ファイル {max} まで。', '{formats} 지원, 파일당 최대 {max}.', 'الصيغ المدعومة: {formats}، حتى {max} لكل ملف.'],
  replaceImage: ['更换图片', 'Replace image', 'Remplacer l’image', 'Cambiar imagen', 'Заменить изображение', 'Bild ersetzen', 'Trocar imagem', '画像を変更', '이미지 변경', 'استبدال الصورة'],
  uploading: ['正在载入图片…', 'Loading image…', 'Chargement de l’image…', 'Cargando imagen…', 'Загрузка изображения…', 'Bild wird geladen…', 'Carregando imagem…', '画像を読み込み中…', '이미지 불러오는 중…', 'جارٍ تحميل الصورة…'],
  save: ['保存', 'Save', 'Enregistrer', 'Guardar', 'Сохранить', 'Speichern', 'Salvar', '保存', '저장', 'حفظ'],
  saveAs: ['另存为', 'Save as', 'Enregistrer sous', 'Guardar como', 'Сохранить как', 'Speichern unter', 'Salvar como', '名前を付けて保存', '다른 이름으로 저장', 'حفظ باسم'],
  saveApply: ['保存并应用', 'Save and apply', 'Enregistrer et appliquer', 'Guardar y aplicar', 'Сохранить и применить', 'Speichern und anwenden', 'Salvar e aplicar', '保存して適用', '저장 및 적용', 'حفظ وتطبيق'],
  applyTheme: ['应用主题', 'Apply theme', 'Appliquer le thème', 'Aplicar tema', 'Применить тему', 'Design anwenden', 'Aplicar tema', 'テーマを適用', '테마 적용', 'تطبيق السمة'],
  saving: ['正在保存…', 'Saving…', 'Enregistrement…', 'Guardando…', 'Сохранение…', 'Wird gespeichert…', 'Salvando…', '保存中…', '저장 중…', 'جارٍ الحفظ…'],
  delete: ['删除', 'Delete', 'Supprimer', 'Eliminar', 'Удалить', 'Löschen', 'Excluir', '削除', '삭제', 'حذف'],
  deleteTheme: ['删除主题', 'Delete theme', 'Supprimer le thème', 'Eliminar tema', 'Удалить тему', 'Design löschen', 'Excluir tema', 'テーマを削除', '테마 삭제', 'حذف السمة'],
  confirmDelete: ['删除这个自定义主题？', 'Delete this custom theme?', 'Supprimer ce thème personnalisé ?', '¿Eliminar este tema personalizado?', 'Удалить эту пользовательскую тему?', 'Dieses eigene Design löschen?', 'Excluir este tema personalizado?', 'このカスタムテーマを削除しますか？', '이 사용자 지정 테마를 삭제할까요?', 'هل تريد حذف هذه السمة المخصّصة؟'],
  reset: ['重置', 'Reset', 'Réinitialiser', 'Restablecer', 'Сбросить', 'Zurücksetzen', 'Redefinir', 'リセット', '초기화', 'إعادة ضبط'],
  resetImage: ['重置图片调整', 'Reset image adjustments', 'Réinitialiser les réglages de l’image', 'Restablecer ajustes de imagen', 'Сбросить настройки изображения', 'Bildanpassungen zurücksetzen', 'Redefinir ajustes da imagem', '画像の調整をリセット', '이미지 조정 초기화', 'إعادة ضبط تعديلات الصورة'],
  positionX: ['水平位置', 'Horizontal position', 'Position horizontale', 'Posición horizontal', 'По горизонтали', 'Horizontale Position', 'Posição horizontal', '横位置', '가로 위치', 'الموضع الأفقي'],
  positionY: ['垂直位置', 'Vertical position', 'Position verticale', 'Posición vertical', 'По вертикали', 'Vertikale Position', 'Posição vertical', '縦位置', '세로 위치', 'الموضع العمودي'],
  zoom: ['缩放', 'Zoom', 'Zoom', 'Zoom', 'Масштаб', 'Zoom', 'Zoom', 'ズーム', '확대/축소', 'التكبير'],
  opacity: ['背景不透明度', 'Background opacity', 'Opacité du fond', 'Opacidad del fondo', 'Непрозрачность фона', 'Deckkraft des Hintergrunds', 'Opacidade do fundo', '背景の不透明度', '배경 불투명도', 'عتامة الخلفية'],
  autoCrop: ['自动裁切', 'Auto crop', 'Recadrage automatique', 'Recorte automático', 'Автообрезка', 'Automatisch zuschneiden', 'Recorte automático', '自動トリミング', '자동 자르기', 'قص تلقائي'],
  name: ['主题名称', 'Theme name', 'Nom du thème', 'Nombre del tema', 'Название темы', 'Designname', 'Nome do tema', 'テーマ名', '테마 이름', 'اسم السمة'],
  namePlaceholder: ['为主题取个名字', 'Name your theme', 'Nommez votre thème', 'Ponle nombre a tu tema', 'Назовите тему', 'Benenne dein Design', 'Dê um nome ao tema', 'テーマ名を入力', '테마 이름 입력', 'أدخل اسماً للسمة'],
  back: ['返回', 'Back', 'Retour', 'Volver', 'Назад', 'Zurück', 'Voltar', '戻る', '뒤로', 'رجوع'],
  close: ['关闭', 'Close', 'Fermer', 'Cerrar', 'Закрыть', 'Schließen', 'Fechar', '閉じる', '닫기', 'إغلاق'],
  cancel: ['取消', 'Cancel', 'Annuler', 'Cancelar', 'Отмена', 'Abbrechen', 'Cancelar', 'キャンセル', '취소', 'إلغاء'],
  retry: ['重试', 'Retry', 'Réessayer', 'Reintentar', 'Повторить', 'Erneut versuchen', 'Tentar novamente', '再試行', '다시 시도', 'إعادة المحاولة'],
  loading: ['正在加载…', 'Loading…', 'Chargement…', 'Cargando…', 'Загрузка…', 'Wird geladen…', 'Carregando…', '読み込み中…', '불러오는 중…', 'جارٍ التحميل…'],
  selected: ['已选择', 'Selected', 'Sélectionné', 'Seleccionado', 'Выбрано', 'Ausgewählt', 'Selecionado', '選択中', '선택됨', 'محدّد'],
  current: ['当前主题', 'Current theme', 'Thème actuel', 'Tema actual', 'Текущая тема', 'Aktuelles Design', 'Tema atual', '現在のテーマ', '현재 테마', 'السمة الحالية'],
  livePreview: ['实时预览', 'Live preview', 'Aperçu en direct', 'Vista previa en vivo', 'Предпросмотр', 'Live-Vorschau', 'Prévia em tempo real', 'リアルタイムプレビュー', '실시간 미리보기', 'معاينة مباشرة'],
  previewHint: ['拖动图片调整构图，也可使用下方滑杆。', 'Drag the image to reframe it, or use the sliders below.', 'Faites glisser l’image pour la cadrer ou utilisez les curseurs ci-dessous.', 'Arrastra la imagen para encuadrarla o usa los controles de abajo.', 'Перетащите изображение для кадрирования или используйте ползунки ниже.', 'Ziehe das Bild zum Ausrichten oder nutze die Regler unten.', 'Arraste a imagem para enquadrar ou use os controles abaixo.', '画像をドラッグするか、下のスライダーで構図を調整できます。', '이미지를 드래그하거나 아래 슬라이더로 구도를 조정하세요.', 'اسحب الصورة لضبط موضعها، أو استخدم أشرطة التمرير أدناه.'],
  unsavedPreview: ['预览尚未保存', 'Preview not saved', 'Aperçu non enregistré', 'Vista previa sin guardar', 'Предпросмотр не сохранён', 'Vorschau nicht gespeichert', 'Prévia não salva', 'プレビューは未保存です', '미리보기가 저장되지 않았습니다', 'المعاينة غير محفوظة'],
  imageLabel: ['主题背景预览', 'Theme background preview', 'Aperçu du fond du thème', 'Vista previa del fondo del tema', 'Предпросмотр фона темы', 'Vorschau des Designhintergrunds', 'Prévia do fundo do tema', 'テーマ背景のプレビュー', '테마 배경 미리보기', 'معاينة خلفية السمة'],
  errorFileType: ['不支持此图片格式，请使用 {formats}。', 'Unsupported image format. Use {formats}.', 'Format d’image non pris en charge. Utilisez {formats}.', 'Formato de imagen no compatible. Usa {formats}.', 'Этот формат изображения не поддерживается. Используйте {formats}.', 'Nicht unterstütztes Bildformat. Verwende {formats}.', 'Formato de imagem não compatível. Use {formats}.', 'この画像形式には対応していません。{formats} を使用してください。', '지원하지 않는 이미지 형식입니다. {formats} 형식을 사용하세요.', 'صيغة الصورة غير مدعومة. استخدم {formats}.'],
  errorFileSize: ['图片文件不能超过 {max}。', 'The image file must be no larger than {max}.', 'Le fichier image ne doit pas dépasser {max}.', 'El archivo de imagen no puede superar {max}.', 'Размер изображения не должен превышать {max}.', 'Die Bilddatei darf höchstens {max} groß sein.', 'O arquivo de imagem não pode exceder {max}.', '画像ファイルは {max} 以下にしてください。', '이미지 파일은 {max} 이하여야 합니다.', 'يجب ألا يتجاوز حجم ملف الصورة {max}.'],
  errorImageLoad: ['无法读取此图片，请换一张重试。', 'This image could not be read. Try another image.', 'Impossible de lire cette image. Essayez une autre image.', 'No se pudo leer esta imagen. Prueba con otra.', 'Не удалось прочитать изображение. Попробуйте другое.', 'Dieses Bild konnte nicht gelesen werden. Versuche ein anderes Bild.', 'Não foi possível ler esta imagem. Tente outra.', '画像を読み込めませんでした。別の画像をお試しください。', '이미지를 읽을 수 없습니다. 다른 이미지를 사용하세요.', 'تعذّرت قراءة هذه الصورة. جرّب صورة أخرى.'],
  errorStorage: ['无法读取或保存主题，请重试。', 'Themes could not be loaded or saved. Try again.', 'Impossible de charger ou d’enregistrer les thèmes. Réessayez.', 'No se pudieron cargar o guardar los temas. Inténtalo de nuevo.', 'Не удалось загрузить или сохранить темы. Повторите попытку.', 'Designs konnten nicht geladen oder gespeichert werden. Versuche es erneut.', 'Não foi possível carregar ou salvar os temas. Tente novamente.', 'テーマを読み込むか保存することができませんでした。もう一度お試しください。', '테마를 불러오거나 저장할 수 없습니다. 다시 시도하세요.', 'تعذّر تحميل السمات أو حفظها. حاول مجدداً.'],
  errorNameRequired: ['请输入主题名称。', 'Enter a theme name.', 'Saisissez un nom de thème.', 'Escribe un nombre para el tema.', 'Введите название темы.', 'Gib einen Designnamen ein.', 'Digite um nome para o tema.', 'テーマ名を入力してください。', '테마 이름을 입력하세요.', 'أدخل اسماً للسمة.'],
  errorNameTooLong: ['主题名称不能超过 {max} 个字符。', 'Theme names must be no longer than {max} characters.', 'Le nom du thème ne doit pas dépasser {max} caractères.', 'El nombre del tema no puede superar los {max} caracteres.', 'Название темы не должно превышать {max} символов.', 'Designnamen dürfen höchstens {max} Zeichen lang sein.', 'O nome do tema não pode exceder {max} caracteres.', 'テーマ名は {max} 文字以内にしてください。', '테마 이름은 {max}자 이하여야 합니다.', 'يجب ألا يتجاوز اسم السمة {max} حرفاً.'],
  errorMaxThemes: ['最多保存 {max} 个自定义主题，请先删除一个。', 'You can save up to {max} custom themes. Delete one first.', 'Vous pouvez enregistrer jusqu’à {max} thèmes personnalisés. Supprimez-en un d’abord.', 'Puedes guardar hasta {max} temas personalizados. Elimina uno primero.', 'Можно сохранить до {max} своих тем. Сначала удалите одну.', 'Du kannst bis zu {max} eigene Designs speichern. Lösche zuerst eines.', 'Você pode salvar até {max} temas personalizados. Exclua um primeiro.', 'カスタムテーマは {max} 個まで保存できます。先に 1 つ削除してください。', '사용자 지정 테마는 최대 {max}개까지 저장할 수 있습니다. 먼저 하나를 삭제하세요.', 'يمكنك حفظ {max} سمات مخصّصة كحد أقصى. احذف واحدة أولاً.'],
  errorGeneric: ['主题操作失败，请重试。', 'The theme action failed. Try again.', 'L’action sur le thème a échoué. Réessayez.', 'La acción sobre el tema falló. Inténtalo de nuevo.', 'Не удалось выполнить действие с темой. Повторите попытку.', 'Die Designaktion ist fehlgeschlagen. Versuche es erneut.', 'A ação no tema falhou. Tente novamente.', 'テーマの操作に失敗しました。もう一度お試しください。', '테마 작업에 실패했습니다. 다시 시도하세요.', 'تعذّر تنفيذ إجراء السمة. حاول مجدداً.'],
  errorConflict: ['主题已在其他窗口更改，已重新载入，请检查后再保存。', 'The themes changed in another window and have been reloaded. Review them before saving again.', 'Les thèmes ont été modifiés dans une autre fenêtre et rechargés. Vérifiez-les avant d’enregistrer à nouveau.', 'Los temas cambiaron en otra ventana y se han vuelto a cargar. Revísalos antes de guardar de nuevo.', 'Темы изменены в другом окне и загружены заново. Проверьте их перед повторным сохранением.', 'Die Designs wurden in einem anderen Fenster geändert und neu geladen. Prüfe sie, bevor du erneut speicherst.', 'Os temas foram alterados em outra janela e recarregados. Confira antes de salvar novamente.', '別のウィンドウでテーマが変更されたため、再読み込みしました。内容を確認してから保存し直してください。', '다른 창에서 테마가 변경되어 다시 불러왔습니다. 내용을 확인한 뒤 다시 저장하세요.', 'تغيّرت السمات في نافذة أخرى وأُعيد تحميلها. راجعها قبل الحفظ مجدداً.'],
} satisfies Record<string, TranslationRow>;

export type ThemeMessageKey = keyof typeof catalog;
export const themeDictionaries = Object.fromEntries(
  languages.map(({ code }, column) => [code, Object.fromEntries(
    Object.entries(catalog).map(([key, values]) => [key, values[column]]),
  )]),
) as Record<Language, Record<ThemeMessageKey, string>>;

/** Preserve unknown keys/placeholders; every supported language has its own complete catalog. */
export function themeT(language: Language, key: ThemeMessageKey, vars?: Record<string, string | number>): string {
  const dictionary = Object.hasOwn(themeDictionaries, language) ? themeDictionaries[language] : undefined;
  const template = dictionary && Object.hasOwn(dictionary, key) ? dictionary[key] : key;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) =>
    vars && Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  );
}
