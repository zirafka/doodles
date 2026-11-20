// Konfigurace Firebase pro Doodle deník.
//
// Hodnoty vložíš z konzole Firebase: Project settings (ozubené kolečko) ->
// General -> Your apps -> webová aplikace (</>) -> SDK setup and configuration
// -> Config. Zkopíruj odtud jednotlivé hodnoty mezi uvozovky níže.
//
// Tyhle hodnoty nejsou tajné, smí být veřejně v repozitáři. Data chrání
// pravidla Firestore (soubor firestore.rules).
//
// Kdyby byly hodnoty prázdné, stránka funguje bez přihlášení a bez ukládání.

export const firebaseConfig = {
  apiKey: "AIzaSyDzawQOQ3PX3R5wyHsI-Fq9WWFlNshdgIs",
  authDomain: "doodle-denik.firebaseapp.com",
  projectId: "doodle-denik",
  storageBucket: "doodle-denik.firebasestorage.app",
  messagingSenderId: "1010394619291",
  appId: "1:1010394619291:web:03daf81cbd0b446823553e",
};
