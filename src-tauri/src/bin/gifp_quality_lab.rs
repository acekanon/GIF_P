fn main() {
    if let Err(error) = gif_p_lib::quality_lab::run_cli(std::env::args().skip(1)) {
        eprintln!("GIFP Quality Lab failed: {error}");
        std::process::exit(1);
    }
}
